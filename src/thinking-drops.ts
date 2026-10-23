import type { ContentBlock, NormalizedMessage, ThinkingBindingEntry } from '@animalabs/membrane';
import type { CompileProvenance, MessageId } from '@animalabs/context-manager';

/**
 * Where a block the provider dropped (membrane's `RoundReport.thinking.dropped`) came from.
 *
 * - `reply`: a block of a stored reply the compile rendered. `bodies` are the stored messages that compiled
 *   message was rendered from (`CompileProvenance`'s raw bodies), each with its id and sequence: usually one,
 *   and more where the store keeps a reply in shards, which can't be told apart by the block alone.
 * - `round`: a block of a round this stream appended itself (the entry's `round`), which no compile holds.
 * - `unplaced`: membrane couldn't place it, or it names a block this request didn't send from a stored reply:
 *   an injected message's, one whose compiled message has no raw body (a summary), or one whose signature no
 *   compiled block carries.
 */
export type PlacedDrop =
  | { kind: 'reply'; bodies: Array<{ messageId: MessageId; sequence: number }>; entry: ThinkingBindingEntry }
  | { kind: 'round'; round: number; entry: ThinkingBindingEntry }
  | { kind: 'unplaced'; entry: ThinkingBindingEntry };

/**
 * What a request was assembled from: the compile's messages as it returned them, its provenance, and, when the
 * compile gave one, the sequence at or below which a reply was stored before the branch's thinking-binding record
 * began (context-manager's `CompileResult.thinkingRecordedAfter`, where it keeps a thinking-binding record).
 */
export interface CompiledForRequest {
  messages: readonly NormalizedMessage[];
  provenance?: CompileProvenance;
  recordedAfter?: number;
}

/** What a stream's driver reads a call's dropped blocks against (`StartStreamResult`'s two fields, together). */
export interface StreamThinkingDrops {
  place: (entries: readonly ThinkingBindingEntry[]) => PlacedDrop[];
  recordedAfter?: number;
}

/** A compile's `thinkingRecordedAfter`, read where context-manager gives it: a sequence, or nothing. */
export function recordedAfterOf(result: unknown): number | undefined {
  const v = (result as { thinkingRecordedAfter?: unknown } | null | undefined)?.thinkingRecordedAfter;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** A signed block's identity on the wire: a thinking block's signature, a redacted block's data. */
function bindingKey(block: ContentBlock | undefined): string | undefined {
  const b = block as { type?: unknown; signature?: unknown; data?: unknown } | undefined;
  if (b?.type === 'thinking' && typeof b.signature === 'string' && b.signature.length > 0) return `s:${b.signature}`;
  if (b?.type === 'redacted_thinking' && typeof b.data === 'string' && b.data.length > 0) return `d:${b.data}`;
  return undefined;
}

/**
 * Place each dropped entry of one call. membrane places a block by the request's message and the block's
 * index in it; the request holds copies of the compile's messages (the sanitize pass, `withoutTokenEstimates`,
 * the request-only rows and `prepareRequest` each copy or move them), so the block is found again in the
 * compile by its signature (or a redacted block's data), which every copy keeps, and the compiled message's
 * provenance names the stored reply.
 */
export function placeThinkingDrops(
  entries: readonly ThinkingBindingEntry[],
  sent: readonly NormalizedMessage[],
  compiled: CompiledForRequest,
): PlacedDrop[] {
  let byKey: Map<string, number> | undefined;
  const compiledIndex = (key: string): number | undefined => {
    if (!byKey) {
      byKey = new Map();
      compiled.messages.forEach((message, i) => {
        for (const block of message.content) {
          const k = bindingKey(block);
          if (k !== undefined && !byKey!.has(k)) byKey!.set(k, i);
        }
      });
    }
    return byKey.get(key);
  };
  return entries.map((entry): PlacedDrop => {
    if (entry.round !== undefined) return { kind: 'round', round: entry.round, entry };
    if (entry.message === undefined || entry.block === undefined) return { kind: 'unplaced', entry };
    const key = bindingKey(sent[entry.message]?.content[entry.block]);
    const at = key === undefined ? undefined : compiledIndex(key);
    const source = at === undefined ? undefined : compiled.provenance?.messages[at];
    if (source?.kind !== 'raw' || source.bodies.length === 0) return { kind: 'unplaced', entry };
    return { kind: 'reply', bodies: source.bodies.map((b) => ({ messageId: b.messageId, sequence: b.sequence })), entry };
  });
}

/**
 * A call's placed drops against the branch's binding-record start (`thinkingRecordedAfter`). Expected: a block of a
 * stored reply whose every body sits at or below it, minted before the context manager recorded what the branch
 * sent, so the provider may drop its thinking with no strip having missed. Unexpected: everything else, a reply
 * above it, a block of the stream's own rounds, or one that couldn't be placed, which the record says the request
 * carried intact.
 */
export function splitThinkingDrops(
  placed: readonly PlacedDrop[],
  recordedAfter: number,
): { expected: PlacedDrop[]; unexpected: PlacedDrop[] } {
  const expected: PlacedDrop[] = [];
  const unexpected: PlacedDrop[] = [];
  for (const drop of placed) {
    const before = drop.kind === 'reply' && drop.bodies.every((body) => body.sequence <= recordedAfter);
    (before ? expected : unexpected).push(drop);
  }
  return { expected, unexpected };
}

/**
 * When an agent's unexpected drops call for an operator alert: at the first call that shows any, and again only
 * when a call shows more than the alert last counted. Each call of a stream, and each stream until a strip takes
 * them out, drops the same blocks again, so an unchanged count isn't news. A call whose report shows none ends the
 * incident, and the next one alerts afresh.
 */
export class ThinkingLossIncidents {
  private readonly alerted = new Map<string, number>();

  /** A call's report of `unexpected` drops for `agent`: the count to alert with, or undefined for no alert. */
  observe(agent: string, unexpected: number): number | undefined {
    if (unexpected === 0) {
      this.alerted.delete(agent);
      return undefined;
    }
    if (unexpected <= (this.alerted.get(agent) ?? 0)) return undefined;
    this.alerted.set(agent, unexpected);
    return unexpected;
  }
}
