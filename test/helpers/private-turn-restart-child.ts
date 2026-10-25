import { AgentFramework } from '../../src/index.js';
import { MockMembrane, createMockResponse } from './mock-membrane.js';

const [storePath, channelId] = process.argv.slice(2);
if (!storePath || !channelId) {
  console.error('usage: private-turn-restart-child <storePath> <channelId>');
  process.exit(2);
}

const membrane = new MockMembrane();
const framework = await AgentFramework.create({
  storePath,
  membrane: membrane.asMembrane(),
  agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }],
  modules: [],
});
const routed: Array<{ text: string; locus: string | null }> = [];
const internals = framework as unknown as {
  channelRegistry: unknown;
  pendingRequests: unknown[];
  turnRouting: Map<string, { triggerChannel?: { serverId: string; channelId: string } }>;
};
internals.channelRegistry = new Proxy({
  getChannelTools: () => [],
  resolveLocus: (agentName: string) => internals.turnRouting.get(agentName)?.triggerChannel ?? { serverId: 'discord', channelId: 'discord:g:lounge' },
  routeSpeech: async (_agent: string, text: string, locus: { serverId: string; channelId: string } | null) => {
    routed.push({ text, locus: locus?.channelId ?? null });
    return { delivered: true, serverId: 'discord', channelId: locus?.channelId };
  },
  deliverSpeech: async (_agent: string, text: string, channel: { channelId: string } | string | null) => {
    const id = typeof channel === 'string' ? channel : channel?.channelId ?? null;
    routed.push({ text, locus: id });
    return { status: 'delivered', destination: { serverId: 'discord', channelId: id }, at: Date.now() };
  },
  resolveProseTarget: (target: string) => ({ serverId: 'discord', channelId: target }),
  resolveDestination: ({ channelId: id }: { channelId: string }) => ({ destination: { serverId: 'discord', channelId: id } }),
  getDefaultPublishChannel: () => ({ serverId: 'discord', channelId: 'discord:g:lounge' }),
  startTyping: () => {},
  getDescriptor: () => undefined,
  channelsNamed: (id: string) => [{ serverId: 'discord', channelId: id }],
  nameShown: (r: { channelId: string }) => r.channelId,
}, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
if (framework.getHostModeStatus().quiesced) await framework.resume();
const landed = framework.getAgent('scout')!.getContextManager().getAllMessages()
  .some((m) => ((m.content[0] as { text?: string }).text ?? '').includes('the build finished'));
const channelTurn = async (calls: number, reply: string) => {
  membrane.pushResponse(createMockResponse([{ type: 'text', text: reply }]));
  internals.pendingRequests.push({
    agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(), channelId, addressed: true,
  });
  while (membrane.calls.length < calls) {
    await framework.runUntilIdle();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await framework.runUntilIdle();
};
await channelTurn(1, 'about the build');
await channelTurn(2, 'and the weather');
await framework.stop();
console.log(JSON.stringify({ landed, routed }));
process.exit(0);
