/**
 * Visibly-empty MCPL content, and the one empty push that is allowed.
 *
 * A push event or channel message whose content gives the model nothing to
 * read cannot be shown: the request sanitizer strips empty text blocks and
 * drops the message they leave empty, so a wake queued for it presents the
 * model with `[Continue]` or with an older message re-presented as the newest.
 * That is a wake with no visible cause, and it invites the model to invent
 * one. Such content is rejected at the MCPL boundary, and the store/wake site
 * drops it as a backstop.
 *
 * The exception is the silent-heartbeat marker: the heartbeat server's own
 * scheduled tick, which wakes with ephemeral host-supplied context instead of
 * a stored message.
 */

/**
 * True when `content` holds nothing the model would see: no non-text block,
 * and no text block whose text has a non-whitespace character. Mirrors the
 * request sanitizer, which drops text that is not a string or trims to ''.
 * Accepts MCPL wire blocks and converted membrane blocks alike.
 */
export function isVisiblyEmptyContent(content: readonly unknown[] | null | undefined): boolean {
  if (!Array.isArray(content)) return true;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type !== 'text') return false;
    if (typeof b.text === 'string' && b.text.trim() !== '') return false;
  }
  return true;
}

/** The server id and feature set the marker must carry. */
export const SILENT_HEARTBEAT_SERVER_ID = 'heartbeat';
export const SILENT_HEARTBEAT_FEATURE_SET = 'heartbeat';

/**
 * The exact silent-heartbeat marker: an empty push from the `heartbeat`
 * server on its `heartbeat` feature set, with `origin.source === 'heartbeat'`
 * and `origin.silent === true`. Anything else that is empty is not a silent
 * tick — arbitrary servers cannot claim the silent path by setting
 * `origin.silent`, and a marker that carries content is ordinary content.
 */
export function isSilentHeartbeatMarker(event: {
  serverId: string;
  featureSet?: string;
  origin?: Record<string, unknown> | null;
  content: readonly unknown[] | null | undefined;
}): boolean {
  return event.serverId === SILENT_HEARTBEAT_SERVER_ID
    && event.featureSet === SILENT_HEARTBEAT_FEATURE_SET
    && event.origin?.source === 'heartbeat'
    && event.origin?.silent === true
    && Array.isArray(event.content)
    && event.content.length === 0;
}
