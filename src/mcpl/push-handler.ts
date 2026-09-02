/**
 * PushHandler — handles push/event messages from MCPL servers.
 *
 * Validates feature sets, deduplicates by eventId, converts MCPL content blocks
 * to membrane ContentBlock[], and pushes McplPushEvents into the processing queue.
 *
 * Spec reference: Section 9 (Push Events).
 */

import type { ContentBlock } from '@animalabs/membrane';
import { INLINE_WITHHELD_TEXT, isInlineContradiction, referenceStubOrNull } from './references.js';

import type {
  McplContentBlock,
  PushEventParams,
  PushEventResult,
} from './types.js';
import type { FeatureSetManager } from './feature-set-manager.js';
import { McplFeatureSetError } from './feature-set-manager.js';
import { expandCoreTags } from './tags.js';

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
}

// ============================================================================
// Content conversion: McplContentBlock → membrane ContentBlock
// ============================================================================

/**
 * Convert a single MCPL wire-format content block to a membrane ContentBlock.
 * Same logic as hook-orchestrator.ts.
 */
export function convertBlock(block: McplContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'image':
      if (isInlineContradiction(block)) {
        // RFC-005 vector 2: inline data claiming bulk disposition — fail
        // closed, withhold the data (checked BEFORE the data branch).
        return { type: 'text', text: INLINE_WITHHELD_TEXT };
      }
      if (block.uri && block.disposition) {
        // RFC-005 uri-form media with a disposition claim: stub, do not
        // hand the URI to the provider or inline it.
        return { type: 'text', text: referenceStubOrNull(block, 'attachment on push event') ?? '[reference]' };
      }
      if (block.data && block.mimeType) {
        return {
          type: 'image',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        } as ContentBlock;
      }
      if (block.uri) {
        return {
          type: 'image',
          source: { type: 'url', url: block.uri },
        } as ContentBlock;
      }
      return { type: 'text', text: '[Image: no data]' };

    case 'audio':
      if (isInlineContradiction(block)) {
        // RFC-005 vector 2: inline data claiming bulk disposition — fail
        // closed, withhold the data (checked BEFORE the data branch).
        return { type: 'text', text: INLINE_WITHHELD_TEXT };
      }
      if (block.uri && block.disposition) {
        // RFC-005 uri-form media with a disposition claim: stub, do not
        // hand the URI to the provider or inline it.
        return { type: 'text', text: referenceStubOrNull(block, 'attachment on push event') ?? '[reference]' };
      }
      if (block.data && block.mimeType) {
        return {
          type: 'audio',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        } as ContentBlock;
      }
      return { type: 'text', text: '[Audio: no data]' };

    case 'resource':
      // RFC-005: reference blocks become bounded stubs — never raw URIs
      // (a signed URL is a bearer credential that looks like a location).
      return { type: 'text', text: referenceStubOrNull(block, 'attachment on push event') ?? '[reference]' };

    default:
      // Unknown wire block types previously fell off the exhaustive switch
      // and propagated `undefined` into ContentBlock[]. Fail visibly.
      return { type: 'text', text: `[unrecognized content block: ${(block as { type?: string }).type ?? 'untyped'}]` };
  }
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

  constructor(
    featureSetManager: FeatureSetManager,
    pushEventFn: (event: McplPushEvent) => void,
    emitTraceFn: (event: { type: string; [key: string]: unknown }) => void,
    shouldTriggerInference?: (content: string, metadata: Record<string, unknown>) => boolean,
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
   * 2. Deduplicate by eventId
   * 3. Optionally check shouldTriggerInference callback
   * 4. Convert content blocks
   * 5. Push event to queue
   * 6. Emit trace
   * 7. Respond with accepted + inferenceId
   */
  handlePushEvent(
    serverId: string,
    params: PushEventParams,
    responder?: Responder,
  ): void {
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
      console.error(`[push-event-rejected] server=${serverId} eventId=${params.eventId} reason=${reason}`);
      if (err instanceof McplFeatureSetError && responder?.respondError) {
        responder.respondError(err.code, reason, { featureSet: err.featureSet });
      } else {
        responder?.respond({ accepted: false, reason });
      }
      return;
    }

    // 2. Deduplicate by eventId
    if (this.dedup.checkAndAdd(params.eventId)) {
      console.error(`[push-event-rejected] server=${serverId} eventId=${params.eventId} reason=duplicate`);
      responder?.respond({ accepted: false, reason: 'duplicate' });
      return;
    }

    // 3. Convert content blocks
    const content: ContentBlock[] = params.payload.content.map(convertBlock);

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
    };
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
}
