/**
 * channel_open's and channel_close's words follow whether the agent's window holds a channel's traffic. A holder (a
 * resident of an unrouted host, a conversation fork for its home, and on a host with no residents the run channel
 * messages are stored with) keeps the registry's words, so its cached tool list doesn't change. A non-holder (any other ephemeral run, and every agent but a fork on a host that routes
 * conversations) is promised nothing about delivery: the registry's "Messages that address you still reach you" was
 * false for it.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { ChannelRegistry, NON_HOLDER_CHANNEL_DESCRIPTIONS } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

interface Internals {
  channelRegistry: unknown;
  agents: Map<string, unknown>;
  conversationRouter?: { touch(channelId: string, now?: number): void; getBinding(channelId: string): unknown };
  conversationAgentHomes: Map<string, string>;
  lastConversationSweep: number;
  sweepExpiredConversations(): void;
  getToolsForAgent(agentName: string): Array<{ name: string; description?: string }>;
}

const internals = (framework: AgentFramework) => framework as unknown as Internals;

/** The registry's own words: what a holder is given. */
const registryTools = new ChannelRegistry({} as McplServerRegistry, {} as FeatureSetManager, () => {}, () => {}).getChannelTools();
const HOLDER = {
  open: registryTools.find((t) => t.name === 'channel_open')!.description,
  close: registryTools.find((t) => t.name === 'channel_close')!.description,
};
const NON_HOLDER = { open: NON_HOLDER_CHANNEL_DESCRIPTIONS.channel_open, close: NON_HOLDER_CHANNEL_DESCRIPTIONS.channel_close };

/** Give the framework the registry's channel tools, and nothing else of a registry. */
function withChannelTools(framework: AgentFramework): void {
  const registry: Record<string, unknown> = { getChannelTools: () => registryTools, getDescriptor: () => undefined };
  internals(framework).channelRegistry = new Proxy(registry, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
}

const words = (tools: Array<{ name: string; description?: string }>) => ({
  open: tools.find((t) => t.name === 'channel_open')?.description,
  close: tools.find((t) => t.name === 'channel_close')?.description,
});

/** The one request the run sent, told apart from any resident's by the run's system prompt. */
function runRequest(membrane: MockMembrane): { tools?: Array<{ name: string; description?: string }> } {
  const sent = (membrane.calls as unknown as Array<{ system?: unknown; tools?: Array<{ name: string; description?: string }> }>)
    .filter((c) => JSON.stringify(c.system ?? '').includes('Do the task.'));
  assert.equal(sent.length, 1, 'the run sent one request');
  return sent[0]!;
}

function mention(channelId: string, text: string): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'srv',
    channelId,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    author: { id: 'U1', name: 'alice' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: { mentioned: true },
    tags: ['chat:addressed'],
    triggerInference: true,
  } as unknown as ProcessEvent;
}

describe("channel_open and channel_close's words follow whether the agent's window holds the channel's traffic", () => {
  let dir: string;
  let membrane: MockMembrane;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'channel-tool-words-'));
    membrane = new MockMembrane();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a non-holder's words promise no delivery, and say the call changes nothing that reaches it", () => {
    // The holder's words are trunk-channel-routing's to pin (#406).
    assert.doesNotMatch(NON_HOLDER.close, /still reach you/);
    assert.match(NON_HOLDER.close, /^Close a channel for every agent on this host\. Closing it stops none of its messages reaching you;/);
    assert.match(NON_HOLDER.open, /^Open a channel for every agent on this host\. Opening it brings you none of its messages;/);
    assert.doesNotMatch(NON_HOLDER.open, /invited you|delivers to you/);
  });

  it("an unrouted host's residents keep the registry's words, and an ephemeral run is given the non-holder's", async () => {
    const framework = await AgentFramework.create({
      storePath: join(dir, 's.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'main', model: 'test-model', systemPrompt: 'You are main.' },
        { name: 'helper', model: 'test-model', systemPrompt: 'You are helper.' },
      ],
      modules: [],
    });
    try {
      withChannelTools(framework);
      // Residents read the shared slot an incoming message is stored in.
      assert.deepEqual(words(internals(framework).getToolsForAgent('main')), HOLDER);
      assert.deepEqual(words(internals(framework).getToolsForAgent('helper')), HOLDER);
      // A run's store is its own, and an incoming message goes to the residents': what its model is sent says so.
      const created = await framework.createEphemeralAgent({ name: 'run-1', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      const run = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      await run;
      const sent = runRequest(membrane);
      assert.deepEqual(words(sent.tools ?? []), NON_HOLDER, JSON.stringify(words(sent.tools ?? [])));
    } finally {
      await framework.stop();
    }
  });

  it("a routed host's trunk is given the non-holder's words, and a fork keeps the registry's for its home, through its closure turn", async () => {
    const framework = await AgentFramework.create({
      storePath: join(dir, 's.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' }],
      modules: [],
      conversations: { templateAgent: 'trunk' },
    });
    try {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
      framework.pushEvent(mention('slack:C1', 'are you there?'));
      await framework.runUntilIdle();
      const fork = [...internals(framework).agents.keys()].find((name) => name !== 'trunk' && !name.startsWith('subconscious'));
      assert.ok(fork, 'the mention made a fork');
      withChannelTools(framework);
      assert.deepEqual(words(internals(framework).getToolsForAgent('trunk')), NON_HOLDER);
      assert.deepEqual(words(internals(framework).getToolsForAgent(fork)), HOLDER);
      // The idle sweep unbinds a fork before its closure turn. Its words don't change for that one turn, which would
      // send its whole window uncached: the closure turn's request carries the registry's.
      internals(framework).conversationRouter!.touch('slack:C1', 0);
      internals(framework).lastConversationSweep = 0;
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'bye' }]));
      const before = membrane.calls.length;
      internals(framework).sweepExpiredConversations();
      await framework.runUntilIdle();
      assert.equal(internals(framework).conversationRouter!.getBinding('slack:C1'), undefined, 'the sweep unbound the home');
      const sent = membrane.calls.slice(before) as unknown as Array<{ tools?: Array<{ name: string; description?: string }> }>;
      assert.equal(sent.length, 1, 'the closure turn was the one request');
      assert.deepEqual(words(sent[0]!.tools ?? []), HOLDER);
    } finally {
      await framework.stop();
    }
  });

  it("on a routed host, every agent but a fork is given the non-holder's words: a resident beside the trunk, and an ephemeral run", async () => {
    // A routed host stores a channel's incoming messages only in the fork its channel is bound to, never in a
    // resident's or a run's window, so no rule naming the trunk alone would do.
    const framework = await AgentFramework.create({
      storePath: join(dir, 's.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' },
        { name: 'helper', model: 'test-model', systemPrompt: 'You are helper.' },
      ],
      modules: [],
      conversations: { templateAgent: 'trunk' },
    });
    try {
      withChannelTools(framework);
      assert.deepEqual(words(internals(framework).getToolsForAgent('trunk')), NON_HOLDER);
      assert.deepEqual(words(internals(framework).getToolsForAgent('helper')), NON_HOLDER);
      const created = await framework.createEphemeralAgent({ name: 'run-1', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      const run = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      await run;
      const sent = runRequest(membrane);
      assert.deepEqual(words(sent.tools ?? []), NON_HOLDER, JSON.stringify(words(sent.tools ?? [])));
    } finally {
      await framework.stop();
    }
  });
});
