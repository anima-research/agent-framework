import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';
import { ToolLifecycleEmitter, type ToolLifecycleParams } from '../src/mcpl/tool-lifecycle.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

const wakeCall = (id: string): ContentBlock => ({
  type: 'tool_use', id, name: 'skip_reply', input: { reason: 'continue later', wake_in_seconds: 60 },
} as ContentBlock);

describe('skip_reply wake capability', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skip-wake-cap-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function make(gate: boolean) {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'same-round text must stay private' },
      wakeCall('wake-1'),
    ] as ContentBlock[], 'tool_use'));
    // A refused call keeps the turn alive; its next ordinary answer must
    // remain public rather than inheriting skip_reply's silencing semantics.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'I cannot schedule that wake.' }] as ContentBlock[]));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
      ...(gate ? { gate: { configPath: join(dir, 'gate.json') } } : {}),
    });
    const routed: string[] = [];
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      getChannelTools: () => [],
      resolveLocus: () => 'channel:test',
      routeSpeech: async (_agent: string, text: string) => {
        routed.push(text);
        return { delivered: true, channelId: 'channel:test' };
      },
      handleChannelToolCall: async (_name: string, input: { wake_in_seconds?: number }) => ({
        success: true, endTurn: true,
        data: { skipped: true, note: `Turn ended; nothing sent. Self-wake in ~${input.wake_in_seconds}s unless something wakes you first.` },
      }),
    }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
    const agent = framework.getAgent('agent')!;
    await (framework as unknown as {
      startAgentStream(agent: unknown, trigger: unknown): Promise<void>;
    }).startAgentStream(agent, {
      agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now(),
    });
    await framework.runUntilIdle();
    return { framework, membrane, routed };
  }

  it('advertises wake_in_seconds only when EventGate is configured', () => {
    const registry = (eventGatePresent: boolean) => new ChannelRegistry(
      {} as McplServerRegistry, {} as FeatureSetManager, () => {}, () => {}, { eventGatePresent },
    );
    const noGateTool = registry(false).getChannelTools().find((tool) => tool.name === 'skip_reply')!;
    const noGateProps = (noGateTool.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.equal('wake_in_seconds' in noGateProps, false);
    assert.doesNotMatch(noGateTool.description, /wake_in_seconds/);

    const gateTool = registry(true).getChannelTools().find((tool) => tool.name === 'skip_reply')!;
    const gateProps = (gateTool.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.equal('wake_in_seconds' in gateProps, true);
    assert.match(gateTool.description, /wake_in_seconds/);
  });

  it('framework wiring exposes timer wake only when its EventGate exists', async () => {
    const noGate = await AgentFramework.create({
      storePath: join(dir, 'framework-no-gate'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
    });
    const withGate = await AgentFramework.create({
      storePath: join(dir, 'framework-with-gate'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
      gate: { configPath: join(dir, 'framework-gate.json') },
    });
    const live = (framework: AgentFramework) => framework as unknown as {
      initializeMcpl(configs: unknown[], routing?: unknown): Promise<void>;
      getAllTools(): Array<{ name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }>;
    };
    await live(noGate).initializeMcpl([]);
    await live(withGate).initializeMcpl([]);
    const absent = live(noGate).getAllTools().find((tool) => tool.name === 'skip_reply')!;
    const present = live(withGate).getAllTools().find((tool) => tool.name === 'skip_reply')!;
    assert.equal('wake_in_seconds' in (absent.inputSchema.properties ?? {}), false);
    assert.doesNotMatch(absent.description, /wake_in_seconds/);
    assert.equal('wake_in_seconds' in (present.inputSchema.properties ?? {}), true);
    assert.match(present.description, /wake_in_seconds/);
    await noGate.stop();
    await withGate.stop();
  });

  it('returns an error and does not end the turn when EventGate is absent', async () => {
    const { framework, membrane, routed } = await make(false);
    const result = membrane.lastStream!.receivedToolResults[0]![0] as { content: string; isError?: boolean };
    assert.equal(result.isError, true);
    assert.match(result.content, /Your turn didn't end, and no wake was set/);
    assert.match(result.content, /call skip_reply without it/);
    assert.equal(membrane.lastStream!.receivedToolResults.length, 1,
      'the refused result resumes the stream instead of falsely ending the turn');
    assert.deepEqual(routed, ['I cannot schedule that wake.'],
      'same-round prose stays private, while next-round prose is deliverable');
    await framework.stop();
  });

  it('does not mutate the stored assistant tool_use input when refusing a wake', async () => {
    const originalInput = { reason: 'continue later', wake_in_seconds: 60 };
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'wake-stored', name: 'skip_reply', input: originalInput },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'continued' }] as ContentBlock[]));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'stored-input'), membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
    });
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      getChannelTools: () => [], resolveLocus: () => 'channel:test',
      routeSpeech: async () => ({ delivered: true, channelId: 'channel:test' }),
      handleChannelToolCall: async () => ({ success: true, endTurn: true, data: { skipped: true } }),
    }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
    const agent = framework.getAgent('agent')!;
    await (framework as unknown as { startAgentStream(agent: unknown, trigger: unknown): Promise<void> })
      .startAgentStream(agent, { agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now() });
    await framework.runUntilIdle();
    const stored = agent.getContextManager().getAllMessages()
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_use' && block.id === 'wake-stored') as { input: Record<string, unknown> } | undefined;
    assert.deepEqual(stored?.input, { reason: 'continue later', wake_in_seconds: 60 });
    assert.deepEqual(originalInput, { reason: 'continue later', wake_in_seconds: 60 });
    await framework.stop();
  });

  it('preserves silence that existed before a refused wake', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'send-1', name: 'channel_publish', input: { channelId: 'channel:test', content: 'sent' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([wakeCall('wake-2')] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'must remain private' }] as ContentBlock[]));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'already-silent'), membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
    });
    const routed: string[] = [];
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      getChannelTools: () => [], resolveLocus: () => 'channel:test',
      routeSpeech: async (_agent: string, text: string) => { routed.push(text); return { delivered: true, channelId: 'channel:test' }; },
      handleChannelToolCall: async () => ({ success: true, data: { delivered: true } }),
    }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
    const agent = framework.getAgent('agent')!;
    await (framework as unknown as { startAgentStream(agent: unknown, trigger: unknown): Promise<void> })
      .startAgentStream(agent, { agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now() });
    await framework.runUntilIdle();
    assert.deepEqual(routed, [], 'refusal must not lift silence established by an earlier explicit send');
    await framework.stop();
  });

  /**
   * A turn on a host with no EventGate: what reached the channel, how many
   * streams it took, and how many of them reached their last response
   * (`completed`), rather than ending at a tool's result. `streams` holds each
   * stream's responses: the first stream's, then a restart's, given to the
   * mock as that stream starts.
   */
  async function turnWithoutGate(store: string, streams: ReturnType<typeof createMockResponse>[][], maxStreamTokens?: number) {
    const membrane = new MockMembrane();
    for (const response of streams[0] ?? []) membrane.pushResponse(response);
    const framework = await AgentFramework.create({
      storePath: join(dir, store), membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test', ...(maxStreamTokens ? { maxStreamTokens } : {}) }], modules: [],
    });
    let starts = 0;
    let completed = 0;
    framework.onTrace((event) => {
      if (event.type === 'inference:completed') completed++;
      if (event.type !== 'inference:started' || ++starts < 2) return;
      for (const response of streams[starts - 1] ?? []) membrane.pushResponse(response);
    });
    const routed: string[] = [];
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      getChannelTools: () => [], resolveLocus: () => 'channel:test',
      routeSpeech: async (_agent: string, text: string) => { routed.push(text); return { delivered: true, channelId: 'channel:test' }; },
      handleChannelToolCall: async () => ({ success: true, data: { delivered: true } }),
    }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
    const agent = framework.getAgent('agent')!;
    await (framework as unknown as { startAgentStream(agent: unknown, trigger: unknown): Promise<void> })
      .startAgentStream(agent, { agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now() });
    await framework.runUntilIdle();
    await framework.stop();
    return { routed, streams: membrane.calls.length, completed };
  }
  const send = (id: string): ContentBlock =>
    ({ type: 'tool_use', id, name: 'channel_publish', input: { channelId: 'channel:test', content: 'sent' } } as ContentBlock);

  it('a refused wake beside a send in its round leaves the send\'s silence on the rest of the turn', async () => {
    const { routed, completed } = await turnWithoutGate('beside-send', [[
      createMockResponse([send('send-1'), wakeCall('wake-1')] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'after the send' }] as ContentBlock[]),
    ]]);
    assert.equal(completed, 1, 'the refusal left the turn open, and it went on to its last response');
    assert.deepEqual(routed, []);
  });

  it('a send after a refused wake silences the rest of the turn: the refusal\'s saved silence comes back once', async () => {
    const { routed, completed } = await turnWithoutGate('send-after', [[
      createMockResponse([wakeCall('wake-1')] as ContentBlock[], 'tool_use'),
      createMockResponse([send('send-1')] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'after the send' }] as ContentBlock[]),
    ]]);
    assert.equal(completed, 1, 'the refusal left the turn open, and it went on to its last response');
    assert.deepEqual(routed, []);
  });

  it('a budget restart after a refused wake starts from its trigger, as after any other round', async () => {
    // A send silences the rest of its stream; then a round crosses the
    // stream's budget, and the turn restarts. Whether that round was a refused
    // wake or a plain tool call, the restarted stream speaks the same: nothing
    // of the refused call outlives its stream.
    const restartedAfter = (store: string, second: ContentBlock) => {
      const overBudget = createMockResponse([{ type: 'text', text: 'this round stays private' }, second] as ContentBlock[], 'tool_use');
      overBudget.usage = { inputTokens: 100, outputTokens: 5 };
      return turnWithoutGate(store, [
        [createMockResponse([send('send-1')] as ContentBlock[], 'tool_use'), overBudget],
        [createMockResponse([{ type: 'text', text: 'after the restart' }] as ContentBlock[])],
      ], 20);
    };
    const refused = await restartedAfter('restart-refused', wakeCall('wake-2'));
    const plain = await restartedAfter('restart-plain', { type: 'tool_use', id: 'think-2', name: 'think', input: { content: 'a plan' } } as ContentBlock);
    assert.equal(refused.streams, 2, 'the refused round crossed the budget, and the turn restarted');
    assert.equal(plain.streams, 2);
    assert.deepEqual(plain.routed, ['after the restart'], 'the restarted stream starts from its trigger, unsilenced');
    assert.deepEqual(refused.routed, plain.routed);
  });

  it('keeps the existing successful end-turn behavior when EventGate exists', async () => {
    const { framework, membrane } = await make(true);
    assert.equal(membrane.lastStream!.receivedToolResults.length, 0,
      'successful skip_reply ends the turn at the tool boundary');
    const wakeState = (framework as unknown as {
      eventGate: { selfWakeTimers: Map<string, unknown> };
    }).eventGate.selfWakeTimers;
    assert.equal(wakeState.has('agent'), true, 'EventGate armed the requested timer');
    await framework.stop();
  });
});


describe('refused wake: no lifecycle events; zero is an ordinary skip', () => {
  async function runProbe(wake: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'skip-wake-probe-'));
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'same-round text must stay private' },
      { type: 'tool_use', id: 'wake-1', name: 'skip_reply', input: { reason: 'later', wake_in_seconds: wake } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'next-round reply' }] as ContentBlock[]));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
    });
    const lifecycle: ToolLifecycleParams[] = [];
    const observer = {
      id: 'observer',
      grant: new CapabilityGrant(new Set(['toolLifecycle.observe']), []),
      sendToolLifecycle: (params: ToolLifecycleParams) => { lifecycle.push(params); },
    };
    (framework as unknown as { toolLifecycleEmitter: ToolLifecycleEmitter }).toolLifecycleEmitter = new ToolLifecycleEmitter({
      observers: () => [observer], configFor: () => undefined, describe: () => ({ class: [] }),
    });
    const routed: string[] = [];
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      getChannelTools: () => [], resolveLocus: () => 'channel:test',
      routeSpeech: async (_agent: string, text: string) => { routed.push(text); return { delivered: true, channelId: 'channel:test' }; },
      handleChannelToolCall: async () => ({ success: true, endTurn: true, data: { skipped: true, note: 'Turn ended; nothing sent.' } }),
    }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
    const agent = framework.getAgent('agent')!;
    await (framework as unknown as { startAgentStream(agent: unknown, trigger: unknown): Promise<void> })
      .startAgentStream(agent, { agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now() });
    await framework.runUntilIdle();
    const results = membrane.lastStream?.receivedToolResults ?? [];
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
    return { lifecycle, routed, results };
  }

  it('A: a refused positive wake sends no lifecycle events', async () => {
    const { lifecycle, routed, results } = await runProbe(60);
    assert.equal((results[0]?.[0] as { isError?: boolean } | undefined)?.isError, true);
    assert.deepEqual(routed, ['next-round reply']);
    assert.deepEqual(lifecycle.map((p) => `${p.toolCallId}:${p.phase}`), []);
  });

  it('B: wake_in_seconds: 0 remains an ordinary skip', async () => {
    const { routed, results } = await runProbe(0);
    assert.deepEqual(routed, []);
    assert.equal(results.length, 0, 'ordinary skip ends at the tool boundary');
  });

  it('C: a wake that doesn\'t read as a finite number asks for none, so it\'s an ordinary skip', async () => {
    // JSON reads a number literal past a double's range, such as 1e400, as
    // Infinity too, but the store can't hold an Infinity in a tool call's
    // input, so these are strings.
    for (const wake of ['Infinity', 'soon']) {
      const { routed, results } = await runProbe(wake);
      assert.deepEqual(routed, [], `wake_in_seconds: ${String(wake)}`);
      assert.equal(results.length, 0, `wake_in_seconds: ${String(wake)} ends the turn at the tool boundary`);
    }
  });
});
