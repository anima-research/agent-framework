/**
 * Test helper: make an already-registered agent look like a conversation
 * fork bound to `channelId`, the way `createConversationAgent` registers
 * one — a home channel, not a broadcast recipient, no provider-scheduling
 * ownership. Returns an undo.
 *
 * Tests that exercise fork-only code paths (injection scoping, channel
 * tool guards, provider-cooldown ownership) use this instead of spawning a
 * real fork through the conversation router.
 */
import type { AgentFramework, AgentRecord } from '../../src/index.js';

type RegistryInternals = { registry: { get(name: string): AgentRecord | undefined } };

export function bindAsConversationFork(
  framework: AgentFramework,
  agentName: string,
  channelId: string,
): () => void {
  const record = (framework as unknown as RegistryInternals).registry.get(agentName);
  if (!record) throw new Error(`bindAsConversationFork: "${agentName}" is not a registered agent`);
  const prior = { homeChannel: record.homeChannel, roles: { ...record.roles } };
  record.homeChannel = channelId;
  record.roles = { ...record.roles, receivesUntargeted: false, ownsProviderScheduling: false };
  return () => {
    if (prior.homeChannel === undefined) delete record.homeChannel;
    else record.homeChannel = prior.homeChannel;
    record.roles = prior.roles;
  };
}

/** The registry's home channel for an agent (what channel routing resolves). */
export function homeChannelOf(framework: AgentFramework, agentName: string): string | undefined {
  return (framework as unknown as RegistryInternals).registry.get(agentName)?.homeChannel;
}
