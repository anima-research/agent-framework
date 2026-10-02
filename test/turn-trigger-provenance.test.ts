/**
 * Turn provenance: the trigger the framework exposes for the turn in progress
 * (getActiveTurnTrigger / the InferenceRequest handed to startAgentStream)
 * must be internally consistent — channel, addressed and counterparty from
 * ONE request — so a host stamping gateway telemetry never reports one
 * person's channel with another person's id.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { InferenceRequest } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function internals(framework: AgentFramework) {
  return framework as unknown as {
    pendingRequests: InferenceRequest[];
    processInferenceRequests(): Promise<void>;
    startAgentStream(agent: unknown, trigger?: InferenceRequest): Promise<void>;
  };
}

describe('Turn trigger provenance', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'turn-trigger-test-'));
    membrane = new MockMembrane();
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function makeFramework() {
    return AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
  }

  /** Spy on startAgentStream: capture the merged trigger and the value the
   *  getter exposes while the turn is alive. */
  function spy(framework: AgentFramework) {
    const i = internals(framework);
    const captured: { handed?: InferenceRequest; exposed?: InferenceRequest } = {};
    const orig = i.startAgentStream.bind(framework);
    i.startAgentStream = async (agent: unknown, trigger?: InferenceRequest) => {
      captured.handed = trigger;
      const p = orig(agent, trigger);
      captured.exposed = framework.getActiveTurnTrigger('scout');
      return p;
    };
    return captured;
  }

  it('a batch where a later ADDRESSED request wins keeps its channel and author together', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi bob' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t,
        channelId: 'discord:g:alice-room', counterparty: 'discord:user:alice', addressed: false },
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t + 1,
        channelId: 'discord:g:bob-room', counterparty: 'discord:user:bob', addressed: true },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();

    assert.equal(captured.handed?.channelId, 'discord:g:bob-room', 'addressed channel wins');
    assert.equal(captured.handed?.addressed, true);
    assert.equal(captured.handed?.counterparty, 'discord:user:bob', 'author must come from the SAME request as the channel');
    assert.equal(captured.exposed?.counterparty, 'discord:user:bob', 'getActiveTurnTrigger exposes the same trigger while the turn runs');
    assert.equal(captured.exposed?.channelId, 'discord:g:bob-room');
    assert.equal(framework.getActiveTurnTrigger('scout'), undefined, 'cleared once the turn ended');
    await framework.stop();
  });

  it('a gate-batched wake (telemetry provenance only) names its author without pinning a speech locus', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: t,
        counterparty: 'discord:user:7', wakeChannelId: 'discord:g:room', wakeAt: t - 500 },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();
    assert.equal(captured.handed?.channelId, undefined, 'a gate wake sets no locus');
    assert.equal(captured.handed?.addressed, false);
    assert.equal(captured.handed?.counterparty, 'discord:user:7');
    assert.equal(captured.handed?.wakeChannelId, 'discord:g:room');
    assert.equal(captured.exposed?.counterparty, 'discord:user:7');
    await framework.stop();
  });

  it('a context-budget restart keeps the channel for routing but names no author', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'continuing' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t,
        channelId: 'discord:g:alice-room', counterparty: 'discord:user:alice', addressed: true },
      { agentName: 'scout', reason: 'context_budget_restart', source: 'framework', timestamp: t + 1 },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();

    assert.equal(captured.handed?.reason, 'context_budget_restart');
    assert.equal(captured.handed?.channelId, 'discord:g:alice-room', 'routing channel is kept');
    assert.equal(captured.handed?.counterparty, undefined, 'a restart is its own cause — no borrowed author');
    await framework.stop();
  });
});

describe('private non-channel trigger batching', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'private-batch-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('does not borrow a sibling channel request from the same batch', async () => {
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'), membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }], modules: [],
    });
    const i = internals(framework);
    const captured: InferenceRequest[] = [];
    i.startAgentStream = async (_agent: unknown, trigger?: InferenceRequest) => {
      if (trigger) captured.push(trigger);
    };
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'external-message', source: 'tui', timestamp: t, nonChannelOrigin: true },
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t + 1,
        channelId: 'discord:g:room', addressed: true },
    );
    await i.processInferenceRequests();
    assert.ok(i.pendingRequests.some((r) => r.channelId === 'discord:g:room'));
    await i.processInferenceRequests();
    assert.equal(captured[0]?.nonChannelOrigin, true);
    assert.equal(captured[0]?.channelId, undefined);
    assert.equal(captured[0]?.addressed, false);
    assert.equal(captured[1]?.channelId, 'discord:g:room', 'requeued channel request gets its own turn');
    assert.equal(captured[1]?.addressed, true);
    await framework.stop();
  });
});

describe('channel_open turn binding', () => {
  it('a stale completion updates active channel but not a newer private turn pin', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'stale-open-test-'));
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test', systemPrompt: 'scout' }], modules: [],
    });
    let resolveOpen!: (value: unknown) => void;
    const pending = new Promise((resolve) => { resolveOpen = resolve; });
    const i = framework as unknown as {
      activeTurnTokens: Map<string, number>; activeTriggerChannels: Map<string, string>;
      turnLocusPins: Map<string, string>; activeTurnTriggers: Map<string, InferenceRequest>;
      channelRegistry: { handleChannelToolCall(...args: unknown[]): Promise<unknown> };
      dispatchChannelToolCall(agent: string, call: unknown): void;
    };
    i.channelRegistry = new Proxy({
      handleChannelToolCall: async () => pending,
    }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined }) as never;
    i.activeTurnTokens.set('scout', 1);
    i.activeTurnTriggers.set('scout', { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: 1 });
    i.turnLocusPins.set('scout', 'discord:g:old');
    i.dispatchChannelToolCall('scout', { id: 'open-1', name: 'channel_open', input: { channelId: 'discord:g:opened' } });

    // A new private turn starts before the old tool resolves.
    i.activeTurnTokens.set('scout', 2);
    i.activeTurnTriggers.set('scout', { agentName: 'scout', reason: 'external-message', source: 'tui', timestamp: 2, nonChannelOrigin: true });
    i.turnLocusPins.delete('scout');
    resolveOpen({ success: true, data: { channelId: 'discord:g:opened', opened: true } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(i.activeTriggerChannels.get('scout'), 'discord:g:opened');
    assert.equal(i.turnLocusPins.has('scout'), false, 'stale completion cannot redirect the new private turn');
    assert.equal(i.activeTurnTriggers.get('scout')!.nonChannelOrigin, true, 'new turn privacy remains set');
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });
});
