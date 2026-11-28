/** Trusted processing origin, not evidence that a message caused a refusal.
 * @experimental
 */
export interface MainRefusalOrigin {
  readonly serverId: string;
  readonly binding: string;
  readonly channelId: string;
  readonly threadId?: string;
  /** Opaque connector message reference. Never an event UUID fallback. */
  readonly messageRef: string;
}

/** Only a final MAIN response, after provider retries and the rewind decision.
 * @experimental
 */
export interface MainRefusal {
  readonly agentName: string;
  readonly agentInstanceId: string;
  readonly turnId: number;
  readonly category: string;
  readonly origin?: MainRefusalOrigin;
  readonly rewind: 'handled' | 'unhandled';
}

/** @experimental */
export type MainRefusalHandler = (refusal: MainRefusal) => void | Promise<void>;

/** Optional host facet. Taking ownership replaces ALL built-in refusal reactions,
 * not only selected servers. Disposing restores legacy behavior. Observation and
 * effect failures must not request inference. No durable/exactly-once guarantee.
 * @experimental
 */
export interface MainRefusalBridge {
  readonly version: 1;
  takeOwnership(handler: MainRefusalHandler): () => void;
  isCurrent(refusal: MainRefusal): boolean;
  serverBinding(serverId: string): string | undefined;
  /** Process-local config OBJECT + connection OBJECT identity, NOT transportEpoch,
   * child PID, reconnect detection, or security/realm/executable attestation.
   * In-place crash/reconnect preserves it; object replacement changes it. */
  serverEpoch(serverId: string): string | undefined;
}
