/**
 * The turn's speech route across a logical turn (shelf-355): decided once at
 * a true new turn, kept by continuations and retries (including a route the
 * resident chose with channel_open), and decided afresh — never inherited —
 * by the next true new turn. A local surface route shows speech there and
 * publishes nothing.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { InferenceRequest, ProcessEvent, Module, ModuleContext, ProcessState, EventResponse, ToolDefinition, ToolCall, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

type Route = { route: { kind: string; channelId?: string; surface?: string; origin?: string } | null; hold?: unknown };

function internals(framework: AgentFramework) {
  return framework as unknown as {
    turnRoutes: Map<string, Route>;
    startAgentStream(agent: unknown, trigger?: InferenceRequest, attempt?: number): Promise<void>;
    channelRegistry: unknown;
  };
}

class SurfaceModule implements Module {
  readonly name = 'console';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'Operator', content: [{ type: 'text', text: String((event as { content?: unknown }).content) }] }],
      requestInference: true,
    };
  }
}

describe('speech route across a logical turn', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'speech-route-turns-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const makeFramework = (modules: Module[] = []) => AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    modules,
  });

  const fromChannel = (channelId: string): InferenceRequest => ({
    agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(),
    routeCandidates: [{ conversation: { kind: 'channel', serverId: 'discord', channelId }, addressed: true, messageId: 'm1', at: Date.now() }],
  });

  it('continuations and retries keep the route — including one chosen with channel_open — and a new turn decides afresh', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    const scout = framework.getAgent('scout')!;

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'one' }]));
    await i.startAgentStream(scout, fromChannel('chan-A'));
    await framework.runUntilIdle();
    assert.equal(i.turnRoutes.get('scout')?.route?.channelId, 'chan-A');

    // The resident opened another channel during this logical turn.
    const opened: Route = { route: { kind: 'channel', channelId: 'chan-open', origin: 'open' } };
    i.turnRoutes.set('scout', opened);

    // A context-budget restart, a guard retry and a framework retry continue
    // the same logical turn: none of them re-decides the route, even with
    // candidates from elsewhere in hand.
    for (const [trigger, attempt] of [
      [{ ...fromChannel('chan-B'), reason: 'context_budget_restart' }, 0],
      [{ ...fromChannel('chan-B'), reason: 'tool_result_guard_retry' }, 0],
      [fromChannel('chan-B'), 1],
    ] as Array<[InferenceRequest, number]>) {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'continuing' }]));
      await i.startAgentStream(scout, trigger, attempt);
      await framework.runUntilIdle();
      assert.equal(i.turnRoutes.get('scout'), opened, `${trigger.reason} (attempt ${attempt}) kept the route`);
    }

    // A true new turn decides from its own wake: none here, so no route.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    await i.startAgentStream(scout, { agentName: 'scout', reason: 'heartbeat', source: 'timer', timestamp: Date.now() });
    await framework.runUntilIdle();
    assert.deepEqual(i.turnRoutes.get('scout'), { route: null });
    await framework.stop();
  });

  it('a local surface wake routes speech to that surface: shown there, published nowhere, receipted as such', async () => {
    const framework = await makeFramework([new SurfaceModule()]);
    const i = internals(framework);
    const published: string[] = [];
    i.channelRegistry = new Proxy({
      resolveLocus: () => null,
      routeSpeech: async (_a: string, text: string) => { published.push(text); return { delivered: true, channelId: 'x' }; },
      getDescriptor: () => undefined,
      getChannelTools: () => [],
    } as Record<string, unknown>, { get: (t, p: string) => (p in t ? t[p] : () => undefined) });

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello, operator.' }]));
    framework.pushEvent({ type: 'external-message', source: 'tui', content: 'hi scout', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    assert.deepEqual(i.turnRoutes.get('scout')?.route, { kind: 'surface', surface: 'tui', origin: 'trigger' });
    assert.deepEqual(published, [], 'surface speech is not published to any channel');
    const texts = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    assert.ok(texts.includes('[delivered] plain speech → tui (the local surface that messaged you; not published to any channel)'));
    assert.ok(texts.some((t) => t.startsWith('[routing] Your plain speech now goes to tui (the local surface that messaged you)')));
    await framework.stop();
  });
});
