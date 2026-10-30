/**
 * A derived agent that shows its owner's tool surface (deriveAgent with no
 * allowedTools, see toolSurfaceOwners) and the host's own toolsets
 * (host-presentation.ts). Its tool block is the front of the request prefix
 * it shares with its owner, so it must be the owner's block, including where
 * the owner has moved a server to a tab. It reads its owner's presentation
 * and can't switch it: its own toolsets--open and --close are refused, and
 * nothing is kept under its name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AutobiographicalStrategy } from '@animalabs/context-manager';
import type { NormalizedRequest } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { startScriptedServer, waitFor, type Json } from './helpers/toolset-servers.js';

const strategy = () => new AutobiographicalStrategy({
  adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000, kvStableReachTokens: 8_000,
});

const PING = { name: 'ping', description: 'Ping the server.', inputSchema: { type: 'object' } };

async function rig() {
  const server = await startScriptedServer({
    advert: { featureSets: { 'srv.tools': { description: 'tools', uses: ['tools'] } } },
    tools: [PING],
    on: (msg, peer) => {
      if (msg.method === 'tools/call') peer.reply(msg.id, { content: [{ type: 'text', text: 'pong' }] });
      else if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'dendrite-host-toolsets-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', strategy: strategy() }],
    modules: [],
    mcplServers: [{ id: 'srv', url: server.url, toolPrefix: 'srv' }],
  });
  await framework.start();
  await waitFor(() => framework.getAllTools().some((t) => t.name === 'srv--ping'), 'srv connected');
  return {
    framework,
    membrane,
    dir,
    async stop() {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const call = (framework: AgentFramework, name: string, input: Json, agent: string) =>
  framework.executeToolCall({ id: `c-${Math.random().toString(36).slice(2, 10)}`, name, input, callerAgentName: agent } as never);
const toolNames = (request: NormalizedRequest | { tools?: Array<{ name: string }> }) =>
  ((request as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name).sort();
const framing = (text: string) => [{ participant: 'user', content: [{ type: 'text' as const, text }] }];

describe('a derived agent and the host\'s toolsets', () => {
  it('advertises its owner\'s tool block after the owner moves a server to a tab', async () => {
    const h = await rig();
    try {
      await call(h.framework, 'toolsets--close', { server: 'srv' }, 'scout');
      const owner = toolNames(await h.framework.previewActivation('scout'));
      assert.ok(!owner.includes('srv--ping'), 'premise: the owner moved srv to a tab');

      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      const before = h.membrane.calls.length;
      const fork = await h.framework.deriveAgent({ name: 'fork-a', from: 'scout', mode: 'copy', framing: framing('Task: look.') });
      await h.framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
      const first = h.membrane.calls.slice(before).find((c) => c.assistantParticipant === 'fork-a');
      assert.ok(first, 'premise: the fork made a request');
      assert.deepEqual(toolNames(first), owner, 'the fork\'s first request carries its owner\'s tool block');
    } finally {
      await h.stop();
    }
  });

  it('refuses its own toolsets--open and --close, and keeps nothing under its name', async () => {
    const h = await rig();
    try {
      const owner = toolNames(await h.framework.previewActivation('scout'));
      h.membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'open-settings', name: 'toolsets--open', input: { toolset: 'settings' } },
        { type: 'tool_use', id: 'close-srv', name: 'toolsets--close', input: { server: 'srv' } },
      ] as never, 'tool_use'));
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      const fork = await h.framework.deriveAgent({ name: 'fork-b', from: 'scout', mode: 'copy', framing: framing('Task: switch.') });
      await h.framework.runEphemeralToCompletion(fork.agent, fork.contextManager);

      const results = new Map<string, { isError?: boolean }>();
      for (const message of fork.contextManager.getAllMessages()) {
        for (const block of message.content as Array<{ type: string; toolUseId?: string; isError?: boolean }>) {
          if (block.type === 'tool_result' && block.toolUseId) results.set(block.toolUseId, block);
        }
      }
      assert.equal(results.size, 2, `premise: both calls were answered (${[...results.keys()].join(', ')})`);
      assert.equal(results.get('open-settings')?.isError, true, 'opening settings is refused');
      assert.equal(results.get('close-srv')?.isError, true, 'moving a server to a tab is refused');

      assert.deepEqual(toolNames(await h.framework.previewActivation('scout')), owner, 'the owner\'s block is unchanged');
      const stored = join(h.dir, 'store', 'config', 'toolsets.json');
      const kept = existsSync(stored) ? readFileSync(stored, 'utf8') : '';
      assert.ok(!kept.includes('fork-b'), `nothing is kept under the fork's name: ${kept}`);
    } finally {
      await h.stop();
    }
  });
});
