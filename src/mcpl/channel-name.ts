import type { ChannelRef } from './channel-registry.js';

/**
 * A channel's server-qualified name, `serverId:channelId`. A name given as a
 * string (a tool's channelId, a `>>` target, a host's call) may take this
 * form to pick one server's channel where several servers register the id.
 * It is looked up among the registered pairs, never split at a colon, since
 * ids hold colons (ChannelRegistry.entriesNamed).
 */
export function qualifiedChannelName(ref: ChannelRef): string {
  return `${ref.serverId}:${ref.channelId}`;
}
