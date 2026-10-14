import { bodyBoundsIn, type BodyShard, type ContextManager, type MessageId } from '@animalabs/context-manager';

type StoredLike = BodyShard & { id: MessageId };
type Removals = Pick<ContextManager, 'removeMessage' | 'removeMessages'>;

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
  const all = cm.getAllMessages();
  const at = all.findIndex((m) => m.id === id);
  const { from, to } = bodyRangeIn(all, at);
  removeStoredMessages(cm, all[from] as StoredLike, all[to] as StoredLike);
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
