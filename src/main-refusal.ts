/** Trusted processing origin, not evidence that a message caused a refusal. */
export interface MainRefusalOrigin {
  readonly serverId: string;
  readonly binding: string;
  readonly channelId: string;
  readonly threadId?: string;
  /** Opaque connector message reference. Never an event UUID fallback. */
  readonly messageRef: string;
}

/** Only a final MAIN response, after provider retries and the rewind decision. */
export interface MainRefusal {
  readonly agentName: string;
  readonly agentInstanceId: string;
  readonly turnId: number;
  readonly category: string;
  readonly origin?: MainRefusalOrigin;
  readonly rewind: 'handled' | 'unhandled';
}

export type MainRefusalHandler = (refusal: MainRefusal) => void | Promise<void>;

/** Optional host facet. Taking ownership replaces ALL built-in refusal reactions,
 * not only selected servers. Disposing restores legacy behavior. Observation and
 * effect failures must not request inference. No durable/exactly-once guarantee. */
export interface MainRefusalBridge {
  readonly version: 1;
  takeOwnership(handler: MainRefusalHandler): () => void;
  isCurrent(refusal: MainRefusal): boolean;
  serverBinding(serverId: string): string | undefined;
  /** Process-local config/connection identity. A replacement requires a new handover. */
  serverEpoch(serverId: string): string | undefined;
}
