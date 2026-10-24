import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextInjection } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { ChannelRegistry, destinationKey, type ChannelRef } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { bindAsConversationFork, homeChannelOf } from './helpers/dendrite.js';

const FORK_AGENT = 'conversation-chanA-g1';

type FrameworkInternals = {
  channelRegistry: ChannelRegistry | null;
  hookOrchestrator: {
    beforeInference(params: unknown): Promise<ContextInjection[]>;
    emitLifecycle(params: unknown): void;
  } | null;
};

class InjectionModule implements Module {
  readonly name = 'injection';
  private triggerAgents: string[];

  constructor(
    private readonly injections: ContextInjection[],
    triggerAgents: string[] = [],
  ) {
    this.triggerAgents = triggerAgents;
  }

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, error: 'No tools', isError: true };
  }
  async onProcess(_event: ProcessEvent): Promise<EventResponse> {
    return this.triggerAgents.length > 0
      ? { requestInference: this.triggerAgents }
      : {};
  }
  async gatherContext(_agentName: string): Promise<ContextInjection[]> {
    return this.injections;
  }
}

function systemInjection(text: string, namespace?: string): ContextInjection {
  const injection: {
    namespace?: string;
    position: 'system';
    content: Array<{ type: 'text'; text: string }>;
  } = {
    position: 'system',
    content: [{ type: 'text', text }],
  };
  if (namespace !== undefined) {
    injection.namespace = namespace;
  }
  return injection as ContextInjection;
}

function frameworkInternals(framework: AgentFramework): FrameworkInternals {
  return framework as unknown as FrameworkInternals;
}

function installChannelRegistry(
  framework: AgentFramework,
  channelIds: string[] = ['chanA', 'chanB'],
  servers: Record<string, unknown> = {},
): ChannelRegistry {
  const internals = frameworkInternals(framework);
  const registry = new ChannelRegistry(
    { getServer: (id: string) => servers[id] ?? null } as never,
    {} as never,
    () => {},
    () => {},
    {
      // A fork's home is on the channels' server, as the framework reads it
      // where one server registers the id.
      homeChannelResolver: (agentName) => {
        const home = homeChannelOf(framework, agentName);
        return home === undefined ? undefined : { serverId: 'srv', channelId: home };
      },
    },
  );
  for (const channelId of channelIds) {
    // §14.5: register first (a conforming server's channels/register),
    // then the incoming message marks the registered channel open.
    (registry as unknown as { channels: Map<string, unknown> }).channels.set(destinationKey({ serverId: 'srv', channelId }), {
      serverId: 'srv', descriptor: { id: channelId, type: 'srv', label: channelId }, open: false,
    });
    registry.handleIncoming('srv', {
      messages: [{
        channelId,
        messageId: `setup-${channelId}`,
        author: { id: 'setup', name: 'setup' },
        timestamp: new Date().toISOString(),
        content: [{ type: 'text', text: 'setup' }],
      }],
    });
  }
  internals.channelRegistry = registry;
  return registry;
}

function bindForkHome(framework: AgentFramework, agentName = FORK_AGENT, channelId = 'chanA'): void {
  bindAsConversationFork(framework, agentName, channelId);
}

function installHookInjections(framework: AgentFramework, injections: ContextInjection[]): void {
  frameworkInternals(framework).hookOrchestrator = {
    beforeInference: async () => injections,
    // §10.5: driveStream emits started/terminal lifecycle notifications
    // through the orchestrator on every turn now.
    emitLifecycle: () => {},
  };
}

function triggerEvent(): ProcessEvent {
  return {
    type: 'external-message',
    source: 'test',
    content: 'trigger',
    metadata: {},
  };
}

function assertContains(text: string | undefined, needle: string): void {
  assert.ok(text?.includes(needle), `expected system prompt to include ${needle}`);
}

function assertOmits(text: string | undefined, needle: string): void {
  assert.ok(!text?.includes(needle), `expected system prompt to omit ${needle}`);
}

describe('conversation fork injection scoping', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework | null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'conv-injection-scope-test-'));
    membrane = new MockMembrane();
    framework = null;
  });

  afterEach(async () => {
    await framework?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function makeFramework(moduleInjections: ContextInjection[], triggerAgents: string[]) {
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'assistant', model: 'test-model', systemPrompt: 'Assistant system.' },
        { name: FORK_AGENT, model: 'test-model', systemPrompt: 'Fork system.' },
      ],
      modules: [new InjectionModule(moduleInjections, triggerAgents)],
    });
    return framework;
  }

  it('scopes module gatherContext injections for conversation forks and keeps hook scoping', async () => {
    membrane.pushResponse(createMockResponse([]));
    const framework = await makeFramework([
      systemInjection('module chanA context', 'chanA'),
      systemInjection('module chanB context', 'chanB'),
      systemInjection('module retrieval context', 'retrieval'),
      systemInjection('module unnamespaced context'),
      // A namespace that is a registered channel's server-qualified name, not
      // its id: channel context is namespaced by id, so it's kept.
      systemInjection('module qualified-name context', 'srv:chanB'),
    ], [FORK_AGENT]);
    installChannelRegistry(framework);
    bindForkHome(framework);
    installHookInjections(framework, [
      systemInjection('hook chanA context', 'chanA'),
      systemInjection('hook chanB context', 'chanB'),
      systemInjection('hook retrieval context', 'retrieval'),
    ]);

    framework.pushEvent(triggerEvent());
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1);
    const system = membrane.calls[0]!.system;
    assertContains(system, 'module chanA context');
    assertOmits(system, 'module chanB context');
    assertContains(system, 'module retrieval context');
    assertContains(system, 'module unnamespaced context');
    assertContains(system, 'module qualified-name context');
    assertContains(system, 'hook chanA context');
    assertOmits(system, 'hook chanB context');
    assertContains(system, 'hook retrieval context');
  });

  it('scopes by a namespace as given, so one holding a lone surrogate that names another channel stays out of the fork', async () => {
    // The namespace is made well formed for the request only after scoping:
    // channel ids are compared as given, and well formed first it would name
    // no channel and reach every agent.
    membrane.pushResponse(createMockResponse([]));
    const other = 'chanB \ud83d';
    const framework = await makeFramework([
      systemInjection('module other context', other),
      systemInjection('module home context', 'chanA'),
    ], [FORK_AGENT]);
    installChannelRegistry(framework, ['chanA', other]);
    bindForkHome(framework);
    installHookInjections(framework, [systemInjection('hook other context', other)]);

    framework.pushEvent(triggerEvent());
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1);
    const system = membrane.calls[0]!.system;
    assertOmits(system, 'module other context');
    assertOmits(system, 'hook other context');
    assertContains(system, 'module home context');
  });

  it('passes module injections through for non-conversation agents', async () => {
    membrane.pushResponse(createMockResponse([]));
    const framework = await makeFramework([
      systemInjection('module chanA context', 'chanA'),
      systemInjection('module chanB context', 'chanB'),
    ], ['assistant']);
    installChannelRegistry(framework);

    framework.pushEvent(triggerEvent());
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1);
    const system = membrane.calls[0]!.system;
    assertContains(system, 'module chanA context');
    assertContains(system, 'module chanB context');
  });

  it('scopes full-fidelity previewActivation module injections like real inference', async () => {
    const framework = await makeFramework([
      systemInjection('preview module chanA context', 'chanA'),
      systemInjection('preview module chanB context', 'chanB'),
    ], []);
    installChannelRegistry(framework);
    bindForkHome(framework);
    installHookInjections(framework, [
      systemInjection('preview hook chanA context', 'chanA'),
      systemInjection('preview hook chanB context', 'chanB'),
    ]);

    const request = await framework.previewActivation(FORK_AGENT, { injections: true });

    assertContains(request.system, 'preview module chanA context');
    assertOmits(request.system, 'preview module chanB context');
    assertContains(request.system, 'preview hook chanA context');
    assertOmits(request.system, 'preview hook chanB context');
    assert.equal(membrane.calls.length, 0, 'previewActivation must not call the membrane');
  });

  it("scopes a channel known only from a push, on a server whose lifecycle this host directs, once its traffic shows it open", async () => {
    const framework = await makeFramework([
      systemInjection('preview module chanA context', 'chanA'),
      systemInjection('preview module dm context', 'dm'),
    ], []);
    // The "dms" server's grant includes channels.lifecycle, so this host
    // directs its channels' lifecycle.
    const registry = installChannelRegistry(framework, ['chanA'], {
      dms: { grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []) },
    });
    bindForkHome(framework);
    registry.ensureChannelRegistered('dms', 'dm', 'DM with someone');
    registry.enterTuneOut('dms', 'dm', {
      epochId: 'e1', cadenceSeconds: 60, backlogCap: 20, maxWakes: 3, startedAtSequence: 1,
    }, 'agent-tool');
    await registry.handleIncoming('dms', {
      messages: [{
        channelId: 'dm',
        messageId: 'dm-1',
        author: { id: 'someone', name: 'someone' },
        timestamp: new Date().toISOString(),
        content: [{ type: 'text', text: 'hello' }],
      }],
    });

    const request = await framework.previewActivation(FORK_AGENT, { injections: true });

    assertContains(request.system, 'preview module chanA context');
    assertOmits(request.system, 'preview module dm context');
  });

  it("keeps a closed or unconfirmed channel's injections with its own fork: a channel never opened, and channels whose server's transport closed", async () => {
    const framework = await makeFramework([
      systemInjection('preview module chanA context', 'chanA'),
      systemInjection('preview module chanB context', 'chanB'),
      systemInjection('preview module chanC context', 'chanC'),
      systemInjection('preview module retrieval context', 'retrieval'),
    ], []);
    const registry = installChannelRegistry(framework);
    // chanC is registered and was never opened.
    (registry as unknown as { channels: Map<string, unknown> }).channels.set(destinationKey({ serverId: 'srv', channelId: 'chanC' }), {
      serverId: 'srv', descriptor: { id: 'chanC', type: 'srv', label: 'chanC' }, open: false,
    });
    // The server's transport closes: chanA and chanB are unconfirmed now.
    registry.transportClosed('srv');
    assert.deepEqual(registry.getOpenChannels(), []);
    bindForkHome(framework);

    const request = await framework.previewActivation(FORK_AGENT, { injections: true });

    assertContains(request.system, 'preview module chanA context');
    assertOmits(request.system, 'preview module chanB context');
    assertOmits(request.system, 'preview module chanC context');
    assertContains(request.system, 'preview module retrieval context');
  });

  it('fails open when the channel registry is absent', async () => {
    membrane.pushResponse(createMockResponse([]));
    const framework = await makeFramework([
      systemInjection('module chanB context', 'chanB'),
    ], [FORK_AGENT]);
    bindForkHome(framework);

    framework.pushEvent(triggerEvent());
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1);
    assertContains(membrane.calls[0]!.system, 'module chanB context');
  });

  it('handles empty module injection lists without throwing', async () => {
    membrane.pushResponse(createMockResponse([]));
    const framework = await makeFramework([], [FORK_AGENT]);
    installChannelRegistry(framework);
    bindForkHome(framework);

    framework.pushEvent(triggerEvent());
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1);
    assert.equal(membrane.calls[0]!.system, 'Fork system.');
  });
});
