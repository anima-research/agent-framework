import { bodyBoundsIn, type BodyShard, type ContextManager, type MessageId } from '@animalabs/context-manager';

type StoredLike = BodyShard & { id: MessageId };
type Removals = Pick<ContextManager, 'removeMessage' | 'removeMessages'>;

/** Minimal read surface the live-surgery helpers need from a ContextManager. */
export interface SurgeryReadableCm {
  getMessageCount(): number;
  getMessageWindow(
    offset: number,
    limit: number,
    opts?: { resolveBlobs?: boolean; alignToBodyGroups?: boolean },
  ): { messages: Array<{ id: unknown; bodyGroupId?: string }>; startIndex: number };
}

const SURGERY_SCAN_WINDOW = 500;

/**
 * Slot index of `messageId` on the active branch, or -1. Scans from the tail
 * in blob-free windows: operator targets are almost always recent, and a
 * full `getAllMessages()` re-inflates every attachment on the branch.
 */
export function locateMessageIndex(cm: SurgeryReadableCm, messageId: string): number {
  const hit = locateMessageIndices(cm, new Set([messageId])).get(messageId);
  return hit ? hit.index : -1;
}

/** Tail-first scan resolving many ids at once; stops as soon as all are found. */
export function locateMessageIndices(
  cm: SurgeryReadableCm,
  ids: Set<string>,
): Map<string, { index: number; bodyGroupId?: string }> {
  const found = new Map<string, { index: number; bodyGroupId?: string }>();
  const total = cm.getMessageCount();
  for (let end = total; end > 0 && found.size < ids.size; end -= SURGERY_SCAN_WINDOW) {
    const start = Math.max(0, end - SURGERY_SCAN_WINDOW);
    const { messages, startIndex } = cm.getMessageWindow(start, end - start, { resolveBlobs: false });
    for (let i = messages.length - 1; i >= 0; i--) {
      const id = String(messages[i].id);
      if (ids.has(id) && !found.has(id)) {
        found.set(id, {
          index: startIndex + i,
          ...(messages[i].bodyGroupId ? { bodyGroupId: messages[i].bodyGroupId } : {}),
        });
      }
    }
  }
  return found;
}

/**
 * Inclusive slot range of the body-group run containing `index` (the slot
 * itself when it is not sharded). Delegates to the store's own
 * `alignToBodyGroups` edge walk — one contiguity assumption, not two.
 */
export function bodyGroupRun(
  cm: SurgeryReadableCm,
  index: number,
): { from: number; to: number; fromId: string; toId: string; group: boolean } {
  const win = cm.getMessageWindow(index, 1, { alignToBodyGroups: true, resolveBlobs: false });
  const from = win.startIndex;
  const to = win.startIndex + win.messages.length - 1;
  return {
    from,
    to,
    fromId: String(win.messages[0].id),
    toId: String(win.messages[win.messages.length - 1].id),
    group: win.messages[0].bodyGroupId !== undefined,
  };
}

/**
 * Remove the stored messages `first`..`last` (inclusive, in store order).
 *
 * A single message outside any body goes through `removeMessage`.
 * context-manager's `removeMessage` refuses any message that carries a body
 * group id, a one-shard body's included, so a shard, and any longer interval,
 * goes through `removeMessages`, which refuses an interval that splits a
 * body.
 */
export function removeStoredMessages(cm: Removals, first: StoredLike, last: StoredLike): void {
  if (first.id === last.id && !first.bodyGroupId) {
    cm.removeMessage(first.id);
    return;
  }
  cm.removeMessages(first.id, last.id);
}

/**
 * Remove one stored message by its id, with the rest of its body when it's
 * in one: a module or a coalescer removes a message it added by the id
 * `addMessage` returned, which for a long message stored in shards is its
 * first shard's.
 */
export function removeStoredMessage(cm: ContextManager, id: MessageId): void {
  const message = cm.getMessage(id) as StoredLike | null;
  if (!message?.bodyGroupId) {
    cm.removeMessage(id);
    return;
  }
  // Found in blob-free windows: a full read of the branch would inflate every
  // attachment on it, once for each message a sweep removes.
  const index = locateMessageIndex(cm, String(id));
  if (index < 0) {
    cm.removeMessage(id);
    return;
  }
  const run = bodyGroupRun(cm, index);
  cm.removeMessages(run.fromId as MessageId, run.toId as MessageId);
}

/** removeStoredMessages for an interval known by its ids. */
export function removeStoredInterval(cm: ContextManager, fromId: MessageId, toId: MessageId): void {
  const first = cm.getMessage(fromId) as StoredLike | null;
  removeStoredMessages(cm, first ?? { id: fromId }, { id: toId });
}

/**
 * The first and last positions (inclusive) of the body that holds
 * `messages[index]`, read the way context-manager 0.14.0 reads bodies
 * (`continuesBody`, pairwise in store order). A message outside any body is a
 * body of its own.
 */
export function bodyRangeIn(messages: readonly unknown[], index: number): { from: number; to: number } {
  return bodyBoundsIn(messages as readonly (BodyShard | null | undefined)[], index);
}
