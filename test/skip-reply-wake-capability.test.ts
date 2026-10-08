import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

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

  it('advertises wake_in_seconds only when EventGate is configured', async () => {
    const noGate = await AgentFramework.create({
      storePath: join(dir, 'no-gate-schema'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
    });
    const channelTools = () => [{
      name: 'skip_reply', description: 'End turn. To end this turn but come back on your own shortly, set wake_in_seconds.',
      inputSchema: { type: 'object' as const, properties: {
        reason: { type: 'string' }, wake_in_seconds: { type: 'number' },
      } },
    }];
    (noGate as unknown as { channelRegistry: unknown }).channelRegistry = { getChannelTools: channelTools, stopAll: () => {} };
    const noGateTool = noGate.getAllTools().find((tool) => tool.name === 'skip_reply')!;
    const noGateProps = (noGateTool.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.equal('wake_in_seconds' in noGateProps, false);
    assert.doesNotMatch(noGateTool.description, /wake_in_seconds/);
    await noGate.stop();

    const withGate = await AgentFramework.create({
      storePath: join(dir, 'with-gate-schema'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
      gate: { configPath: join(dir, 'schema-gate.json') },
    });
    (withGate as unknown as { channelRegistry: unknown }).channelRegistry = { getChannelTools: channelTools, stopAll: () => {} };
    const gateTool = withGate.getAllTools().find((tool) => tool.name === 'skip_reply')!;
    const gateProps = (gateTool.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.equal('wake_in_seconds' in gateProps, true);
    await withGate.stop();
  });

  it('returns an error and does not end the turn when EventGate is absent', async () => {
    const { framework, membrane, routed } = await make(false);
    const result = membrane.lastStream!.receivedToolResults[0]![0] as { content: string; isError?: boolean };
    assert.equal(result.isError, true);
    assert.match(result.content, /No EventGate configured \(FrameworkConfig\.gate is unset\)/);
    assert.equal(membrane.lastStream!.receivedToolResults.length, 1,
      'the refused result resumes the stream instead of falsely ending the turn');
    assert.deepEqual(routed, ['I cannot schedule that wake.'],
      'same-round prose stays private, while next-round prose is deliverable');
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

// Lifecycle backstop: even if a refused-wake stream exits before its resumed
// round can consume the one-shot state, teardown/fresh-turn setup clears it.
describe('refused wake lifecycle cleanup', () => {
  it('fresh turn setup clears stale saved silence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skip-wake-stale-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
    });
    const internals = framework as unknown as {
      refusedSkipReplyWakeRounds: Map<string, boolean>;
      startAgentStream(agent: unknown, trigger: unknown): Promise<void>;
    };
    internals.refusedSkipReplyWakeRounds.set('agent', true);
    // No provider response is needed: startAgentStream's fresh-turn setup runs
    // synchronously before driveStream consumes the mock stream.
    const agent = framework.getAgent('agent')!;
    const start = internals.startAgentStream(agent, {
      agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now(),
    });
    assert.equal(internals.refusedSkipReplyWakeRounds.has('agent'), false);
    await framework.stop();
    await start.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
});
