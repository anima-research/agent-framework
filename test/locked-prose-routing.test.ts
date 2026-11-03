/**
 * Locked prose routing (AgentConfig.proseRouting 'locked'): an agent's plain
 * speech goes to one destination it chose, on every turn, and nothing moves it
 * but its own prose_locus call — not the channel a turn came from, an
 * addressed message mid-turn, a heartbeat, or the host's locus rule. Pointed
 * at drafts (or with no destination yet), plain speech is held as drafts.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  AgentConfig,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

/** A tool module whose `move` can push a message mid-turn, as a chat reply arriving while a tool runs. */
class RobotModule implements Module {
  readonly name = 'robot';
  framework: AgentFramework | null = null;
  interjection: { text: string; metadata: Record<string, unknown> } | null = null;

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{ name: 'move', description: 'Move the robot', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (this.interjection) {
      const { text, metadata } = this.interjection;
      this.interjection = null;
      this.framework!.pushEvent({ type: 'external-message', source: 'test', content: text, metadata } as unknown as ProcessEvent);
    }
    return { success: true, data: { ok: true, tool: call.name } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content);
    const metadata = (event as { metadata?: Record<string, unknown> }).metadata;
    return {
      addMessages: [{ participant: 'Antra', content: [{ type: 'text', text }], ...(metadata ? { metadata } : {}) }],
      requestInference: text === 'go',
    };
  }
}

const CHANNELS: Record<string, string> = {
  '#main': 'discord:g:main',
  '#ops': 'discord:g:ops',
  '@antra': 'discord:dm:antra',
};

/** A registry stand-in: names resolve by CHANNELS, deliveries are recorded, and resolveLocus counts its calls. */
function stubChannelRegistry(framework: AgentFramework) {
  const routed: Array<{ text: string; locus: string | null }> = [];
  const state = { locusCalls: 0 };
  const explicit: Record<string, unknown> = {
    resolveLocus: () => {
      state.locusCalls++;
      return { serverId: 'stub', channelId: 'discord:g:lounge' };
    },
    resolveProseTarget: (spec: string) => (CHANNELS[spec]
      ? { serverId: 'stub', channelId: CHANNELS[spec], label: spec }
      : { error: `no channel matches "${spec}"` }),
    routeSpeech: async (_agent: string, text: string, locus?: { serverId: string; channelId: string } | null) => {
      routed.push({ text, locus: locus?.channelId ?? null });
      return locus ? { delivered: true, serverId: locus.serverId, channelId: locus.channelId } : null;
    },
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
    channelsNamed: (name: string) => [{ serverId: 'stub', channelId: name }],
    nameShown: (channel: { channelId: string }) => channel.channelId,
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return { routed, state };
}

type Stored = { content: Array<{ type: string; text?: string }> };

describe('locked prose routing', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: RobotModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'locked-prose-'));
    membrane = new MockMembrane();
    module = new RobotModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(
    agent: Partial<AgentConfig> = {},
    options: { speech?: { locus: 'delivery' | 'latest-inbound' } } = {},
  ): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.', proseRouting: 'locked', ...agent }],
      modules: [module],
      ...(options.speech ? { speech: options.speech } : {}),
    });
    module.framework = framework;
    return framework;
  }

  /** A turn woken by an addressed message in #lounge, which locus mode would answer there. */
  function trigger(framework: AgentFramework): void {
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'go',
      metadata: { channelId: 'discord:g:lounge', serverId: 'stub', tags: ['chat:addressed'] },
    } as unknown as ProcessEvent);
  }

  function windowTexts(framework: AgentFramework): string[] {
    const cm = framework.getAgent('assistant')!.getContextManager();
    return (cm.getAllMessages() as unknown as Stored[])
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '');
  }

  function toolResultTexts(): string[] {
    return membrane.lastStream!.receivedToolResults.flat().map((r) => JSON.stringify(r));
  }

  it('plain speech goes to the lock, not the channel the turn came from, and the switch is primed once', async () => {
    // One stream takes every response queued, so each turn's is queued after the last turn.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello from the lock.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed, state } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Still here.' }] as ContentBlock[]));
    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'Hello from the lock.', locus: 'discord:g:main' },
      { text: 'Still here.', locus: 'discord:g:main' },
    ]);
    assert.equal(state.locusCalls, 0, 'a locked turn never asks the registry for a locus');
    const primers = windowTexts(framework).filter((t) => t.startsWith('[prose-routing]'));
    assert.deepEqual(primers, [
      '[prose-routing] Locked routing: your plain speech goes to discord:g:main, on every turn, until you move it with prose_locus. ' +
        'The channel a message comes from no longer moves it; other channels need an explicit send tool.',
    ]);
    assert.ok(!windowTexts(framework).some((t) => t.startsWith('[routing]')), 'no locus announcements');
    await framework.stop();
  });

  it('an addressed message mid-turn moves nothing, under either locus rule, and the agent is told', async () => {
    for (const locus of ['delivery', 'latest-inbound'] as const) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = mkdtempSync(join(tmpdir(), 'locked-prose-'));
      membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Moving north.' },
        { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Arrived.' }] as ContentBlock[]));
      const framework = await createFramework({ proseLock: '#main' }, { speech: { locus } });
      const { routed } = stubChannelRegistry(framework);
      module.interjection = { text: 'psst, over here', metadata: { channelId: 'discord:dm:antra', serverId: 'stub', tags: ['chat:addressed'] } };

      trigger(framework);
      await framework.runUntilIdle();

      assert.deepEqual(routed, [
        { text: 'Moving north.', locus: 'discord:g:main' },
        { text: 'Arrived.', locus: 'discord:g:main' },
      ], `${locus}: the lock holds`);
      const wired = membrane.lastStream!.receivedToolResultOptions
        .flatMap((o) => o?.injectedMessages ?? [])
        .map((m) => JSON.stringify(m.content));
      assert.ok(
        wired.some((s) => s.includes('addressed you from discord:dm:antra while you were busy. ' +
          'Your plain speech still lands in discord:g:main; reaching them takes an explicit send.')),
        `${locus}: the addressed-elsewhere notice rode the injection batch`,
      );
      assert.ok(!wired.some((s) => s.includes('The conversation moved to')), `${locus}: no re-pin notice`);
      await framework.stop();
    }
  });

  it('prose_locus moves the lock from the next round, for later turns, and across a restart', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Heading to ops.' },
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: '#ops' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Now in ops.' }] as ContentBlock[]));
    let framework = await createFramework({ proseLock: '#main' });
    let { routed } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();
    assert.ok(
      toolResultTexts().some((t) => t.includes('Your plain speech now goes to discord:g:ops, on this turn') && t.includes('later turns')),
      'the result says where speech goes now',
    );
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Next turn, still ops.' }] as ContentBlock[]));
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [
      { text: 'Heading to ops.', locus: 'discord:g:main' },
      { text: 'Now in ops.', locus: 'discord:g:ops' },
      { text: 'Next turn, still ops.', locus: 'discord:g:ops' },
    ]);
    await framework.stop();

    // The choice outlives the process, and outranks the recipe's proseLock.
    membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'After the restart.' }] as ContentBlock[]));
    framework = await createFramework({ proseLock: '#main' });
    ({ routed } = stubChannelRegistry(framework));
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'After the restart.', locus: 'discord:g:ops' }]);
    await framework.stop();
  });

  it('pointed at drafts, plain speech is held as drafts, posted nowhere, and named in the receipt', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Last public word.' },
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: 'drafts' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Thinking aloud, unposted.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Last public word.', locus: 'discord:g:main' }]);
    assert.ok(
      toolResultTexts().some((t) => t.includes('Your plain speech is now held as drafts')),
      'the result says speech is held as drafts',
    );
    const receipts = windowTexts(framework).filter((t) => t.startsWith('[delivered]'));
    assert.equal(receipts.length, 1);
    assert.match(receipts[0]!, /^\[delivered\] plain speech → discord:g:main · 1 plain-speech segment\(s\) held as draft d-/);
    assert.ok(!windowTexts(framework).some((t) => t.startsWith('[drafts]')), 'no per-round draft notice');
    await framework.stop();
  });

  it('with no lock chosen and no proseLock, plain speech is held as drafts', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Nowhere to go yet.' }] as ContentBlock[]));
    const framework = await createFramework();
    const { routed } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'nothing was posted');
    const texts = windowTexts(framework);
    assert.ok(texts.some((t) => t.startsWith('[prose-routing] Locked routing: your plain speech is held as drafts')), 'the primer says so');
    assert.ok(texts.some((t) => /^\[delivered\] nothing — 1 plain-speech segment\(s\) held as draft d-/.test(t)), 'the receipt names the draft');
    await framework.stop();
  });

  it('a heartbeat turn speaks into the lock', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Beat.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);

    (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'assistant', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(),
    });
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Beat.', locus: 'discord:g:main' }]);
    assert.ok(!windowTexts(framework).some((t) => t.includes('This turn came from your heartbeat')), 'no heartbeat no-channel notice');
    await framework.stop();
  });

  it('a target that does not resolve moves nothing; prose_locus with no target reports the lock', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: '#nowhere' } },
      { type: 'tool_use', id: 'pl2', name: 'prose_locus', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Still main.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    const results = toolResultTexts();
    assert.ok(results.some((t) => t.includes('\\"#nowhere\\" did not resolve') && t.includes('Your plain speech still goes to discord:g:main')), 'refused, naming the lock');
    assert.ok(results.some((t) => t.includes('Your plain speech goes to discord:g:main.')), 'reported');
    assert.deepEqual(routed, [{ text: 'Still main.', locus: 'discord:g:main' }]);
    await framework.stop();
  });

  it('channel_open moves nothing, and its result says where plain speech still goes', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'co1', name: 'channel_open', input: { channelId: 'discord:g:ops', serverId: 'stub' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Opened ops, speaking in main.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    registry.handleChannelToolCall = async () => ({ success: true, data: { channelId: 'discord:g:ops', serverId: 'stub' } });

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Opened ops, speaking in main.', locus: 'discord:g:main' }]);
    assert.ok(
      toolResultTexts().some((t) => t.includes('Your plain speech still goes to discord:g:main; prose_locus moves it.')),
      'the open says where speech still goes',
    );
    await framework.stop();
  });

  it('prose_locus is offered only to a locked agent, and refuses any other', async () => {
    const locked = await createFramework({ proseLock: '#main' });
    stubChannelRegistry(locked);
    const offered = (f: AgentFramework): string[] =>
      (f as unknown as { availableToolsForPresentation(name: string): ToolDefinition[] })
        .availableToolsForPresentation('assistant').map((t) => t.name);
    assert.ok(offered(locked).includes('prose_locus'));
    await locked.stop();

    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), 'locked-prose-'));
    const plain = await createFramework({ proseRouting: 'locus' });
    stubChannelRegistry(plain);
    assert.ok(!offered(plain).includes('prose_locus'));
    const result = await plain.executeToolCall({ id: 'x', name: 'prose_locus', input: { to: '#ops' }, callerAgentName: 'assistant' } as ToolCall);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /applies only under locked prose routing/);
    await plain.stop();
  });
});
