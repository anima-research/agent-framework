import type { InboundSource } from './mcpl/inbound-source.js';
import type { MainRefusalOrigin } from './main-refusal.js';

// Private to the admission/stream implementation, not a field a host request or
// adapter metadata can claim. Enumerable so the scheduler's request copies keep it.
const ORIGIN = Symbol('admitted-main-refusal-origin');
type Mark = { [ORIGIN]?: MainRefusalOrigin };

/** Mark only trusted admitted content. A mark confers no wake: it is consumed
 * only by a direct admission.wake branch or an actual gate batch delivery. */
export function admittedRefusalOrigin(source: InboundSource | undefined, tags?: readonly string[], firstView = false): Mark {
  if (!source || source.kind !== 'channel' || !source.messageId || !source.binding) return {};
  if (tags?.some(t => ['chat:reaction', 'chat:reaction-remove', 'chat:deleted', 'chat:system'].includes(t)
    || (t === 'chat:edited' && !firstView))) return {};
  return refusalOriginMark(Object.freeze({
    serverId: source.serverId, binding: source.binding, channelId: source.channelId,
    ...(source.threadId ? { threadId: source.threadId } : {}), messageRef: source.messageId,
  }));
}

export function refusalOriginMark(origin: MainRefusalOrigin | undefined): Mark {
  return { [ORIGIN]: origin };
}
export function refusalOriginOf(request: object | undefined): MainRefusalOrigin | undefined {
  return (request as Mark | undefined)?.[ORIGIN];
}

/** Never select the newest/earliest routing winner. An unknown cause makes the
 * batch ambiguous; repeated deliveries of the SAME scoped message are one. */
export function mergeRefusalOrigins(requests: readonly object[]): Mark {
  const origins = requests.map(refusalOriginOf);
  if (!origins.length || origins.some(o => !o)) return refusalOriginMark(undefined);
  const keys = new Set(origins.map(o => JSON.stringify([o!.serverId, o!.binding, o!.channelId, o!.threadId, o!.messageRef])));
  return refusalOriginMark(keys.size === 1 ? origins[0] : undefined);
}
