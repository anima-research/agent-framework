import assert from 'node:assert/strict';
import type { AgentFramework } from '../../src/index.js';
import type { ChannelRef } from '../../src/mcpl/channel-registry.js';

/** Make a binding look idle past the TTL and re-arm the sweep throttle —
 * deterministic expiry instead of racing a 1ms TTL against the wall clock. */
export function forceExpiry(framework: AgentFramework, channel: ChannelRef, idleTtlMs: number): void {
  const binding = framework.getConversationRouter()!.getBinding(channel);
  assert.ok(binding, `binding for ${channel.channelId} should exist before forcing expiry`);
  binding!.lastActivity = Date.now() - idleTtlMs - 1_000;
  (framework as unknown as { lastConversationSweep: number }).lastConversationSweep = 0;
}
