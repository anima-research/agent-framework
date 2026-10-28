import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolsetServerSpec } from '@animalabs/mcpl-core/toolsets';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { ChannelRegistry, type ChannelRef } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { serveToolsetServer, makeFramework, waitFor, callTool, resultText } from './helpers/toolset-servers.js';

describe('a form the framework offers, beside a name that differs only by whitespace at its edges', () => {
  it('reaches its own channel through the reader that receives it', async () => {
    const opened: string[] = [];
    const server = {
      grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
      sendChannelsOpen: async (p: { channelId: string }) => { opened.push(p.channelId); return {}; },
      sendChannelsClose: async () => ({}),
    };
    const registry = new ChannelRegistry({ getServer: () => server } as unknown as McplServerRegistry, {} as FeatureSetManager, () => {}, () => {}, {});
    const spaced: ChannelRef = { serverId: 'discord', channelId: 'x ' };
    const plain: ChannelRef = { serverId: 'discord', channelId: 'x' };
    registry.ensureChannelRegistered('discord', spaced.channelId);
    registry.ensureChannelRegistered('discord', plain.channelId);
    const agent = { kind: 'agent', agentName: 'scout' } as never;

    assert.equal(registry.nameShown(spaced), '"x " on server "discord"');
    const [, channelId, serverId] = /^("(?:[^"\\]|\\.)*") on server ("(?:[^"\\]|\\.)*")$/.exec(registry.nameShown(spaced))!;
    assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: JSON.parse(channelId!), serverId: JSON.parse(serverId!) }, agent)).success, true);
    assert.deepEqual(opened, ['x '], 'the id and server it is shown by open it');

    assert.equal(registry.nameShown(plain), 'x');
    assert.equal((registry.resolveProseTarget('x') as { channelId?: string }).channelId, 'x');
    for (const ref of [spaced, plain]) {
      const target = registry.proseTargetFor(ref);
      if (target !== undefined) assert.equal((registry.resolveProseTarget(target) as { channelId?: string }).channelId, ref.channelId, JSON.stringify(target));
    }
    assert.equal(registry.proseTargetFor(spaced), undefined, 'no token offered for the spaced id');
  });

  describe('a tool, through the toolsets meta-tools', () => {
    const calls: string[] = [];
    const toolset = (title: string, names: string[]): ToolsetServerSpec['toolsets'][string] => ({
      title, summary: title, default: 'closed',
      tools: names.map((name) => ({ name, description: `${title} ${name}.`, inputSchema: { type: 'object', properties: {} } })),
      open: () => ({
        title, visible: () => names,
        call: async (tool) => { calls.push(`${title}:${tool}`); return { content: [{ type: 'text' as const, text: 'ok' }] }; },
        close: () => undefined,
      }),
    });
    const pad: ToolsetServerSpec = { name: 'pad', version: '1.0.0', idleCloseMs: 0, toolsets: { keys: toolset('keys', ['press', 'press ']) } };
    const pod: ToolsetServerSpec = { name: 'pod', version: '1.0.0', idleCloseMs: 0, toolsets: { keys: toolset('pod-keys', ['press']) } };
    const srvs: Array<Awaited<ReturnType<typeof serveToolsetServer>>> = [];
    let fw: Awaited<ReturnType<typeof makeFramework>>;
    before(async () => {
      for (const spec of [pad, pod]) srvs.push(await serveToolsetServer(spec));
      fw = await makeFramework([
        { id: 'pad', toolPrefix: 'pad', url: srvs[0]!.url, toolHints: true },
        { id: 'pod', toolPrefix: 'pod', url: srvs[1]!.url, toolHints: true },
      ]);
      await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'toolsets--act'), 'meta-tools listed');
    });
    after(async () => {
      await fw?.stop();
      for (const srv of srvs) await srv.close();
    });

    it('calls exactly the tool the selector names, and the trimmed one only when nothing has the name as written', async () => {
      const opened = await callTool(fw.framework, 'toolsets--open', { server: 'pad', toolset: 'keys' });
      assert.ok(!opened.isError, resultText(opened));
      assert.match(resultText(opened), /"press "\(\)/, 'the spaced tool, named as JSON');
      for (const tool of ['press ', ' press', 'press']) {
        const acted = await callTool(fw.framework, 'toolsets--act', { server: 'pad', tool, args: {} });
        assert.ok(!acted.isError, resultText(acted));
      }
      assert.deepEqual(calls, ['keys:press ', 'keys:press', 'keys:press']);
    });

    it('reads a selector exactly only within the server the call names', async () => {
      calls.length = 0;
      const opened = await callTool(fw.framework, 'toolsets--open', { server: 'pod', toolset: 'keys' });
      assert.ok(!opened.isError, resultText(opened));
      const acted = await callTool(fw.framework, 'toolsets--act', { server: 'pod', tool: 'press ', args: {} });
      assert.ok(!acted.isError, resultText(acted));
      assert.deepEqual(calls, ['pod-keys:press'], 'another server\'s "press " leaves this one\'s selector trimmed');
    });
  });
});
