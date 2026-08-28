import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type {
  ContextEntry,
  ContextLogView,
  ContextStrategy,
  MessageStoreView,
  ReadinessState,
  StrategyContext,
  TokenBudget,
} from '@animalabs/context-manager';
import type {
  ContentBlock,
  NormalizedRequest,
  NormalizedResponse,
  YieldingStream,
} from '@animalabs/membrane';
import {
  AgentFramework,
  ApiModule,
  type EventResponse,
  type Module,
  type ModuleContext,
  type ProcessEvent,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from '../src/index.js';
import { createMockResponse, MockYieldingStream } from './helpers/mock-membrane.js';

class RejectInferenceMembrane {
  calls = 0;

  async complete(_request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls++;
    throw new Error('retired resident ran maintenance inference');
  }

  streamYielding(_request: NormalizedRequest): YieldingStream {
    this.calls++;
    throw new Error('retired resident ran conversational inference');
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

class AlwaysQueuedStrategy implements ContextStrategy {
  readonly name = 'always-queued-retirement-test';

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'would require model-authored maintenance' };
  }

  async tick(ctx: StrategyContext): Promise<void> {
    await ctx.membrane?.complete({
      model: 'test-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'maintenance' }] }],
    } as unknown as NormalizedRequest);
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

class LiveOnlyModule implements Module {
  readonly name = 'resident';
  handled = 0;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  getLiveTools(agentName: string): ToolDefinition[] {
    return agentName === 'resident'
      ? [{ name: 'lifecycle', description: 'live only', inputSchema: { type: 'object' } }]
      : [];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.handled++;
    return { success: true, data: { ok: true } };
  }
  async onProcess(_event: ProcessEvent): Promise<EventResponse> { return {}; }
}

class LiveToolMembrane {
  calls = 0;
  async complete(_request: NormalizedRequest): Promise<NormalizedResponse> {
    throw new Error('unexpected complete');
  }
  streamYielding(_request: NormalizedRequest): YieldingStream {
    this.calls++;
    return new MockYieldingStream([
      createMockResponse([{
        type: 'tool_use',
        id: 'live-call',
        name: 'resident--lifecycle',
        input: {},
      } as ContentBlock], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'live call completed' }]),
    ]);
  }
  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

describe('resident retirement', () => {
  it('seals through the neutral API, clears wake state, preserves history, and blocks restart inference', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-resident-retirement-'));
    const storePath = join(dir, 'store');
    const sealPath = join(storePath, 'resident-retirements.jsonl');
    const membrane = new RejectInferenceMembrane();
    let framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'resident',
        model: 'test-model',
        systemPrompt: 'test',
        retirement: { enabled: true },
      }],
      modules: [new ApiModule()],
      gate: { config: { policies: [], default: 'always' } },
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });

    try {
      framework.getAgent('resident')!.getContextManager().addMessage(
        'User',
        [{ type: 'text', text: 'history survives' }],
      );
      const gate = (framework as unknown as {
        eventGate: {
          armSelfWake(agent: string, seconds: number): unknown;
          setSleep(seconds: number, note: string, agent: string): unknown;
          getSleepState(): unknown;
          selfWakeTimers: Map<string, unknown>;
        };
      }).eventGate;
      gate.armSelfWake('resident', 60);
      gate.setSleep(60, 'retirement test', 'resident');

      const result = framework.retireResident('resident', 'resident-authored test reason');
      assert.equal(result.status, 'retired');
      assert.equal(result.alreadyRetired, false);
      assert.equal(result.chronicleRecorded, true);
      assert.equal(gate.getSleepState(), null);
      assert.equal(gate.selfWakeTimers.has('resident'), false);
      assert.equal(framework.nudgeAgent('resident').ok, false);

      const repeat = framework.retireResident('resident', 'replacement reason');
      assert.equal(repeat.alreadyRetired, true);
      assert.equal(repeat.reason, 'resident-authored test reason');

      const seals = readFileSync(sealPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(seals.length, 1);
      assert.equal(seals[0].agentName, 'resident');
      assert.equal(seals[0].kind, 'resident-retired');

      const lifecycle = framework.getStore().getStateJson('framework/resident-lifecycle') as unknown[];
      assert.equal(lifecycle.length, 1);

      const before = await framework.getAgent('resident')!.compileContext();
      assert.match(JSON.stringify(before), /history survives/);
      (framework as unknown as {
        addMessage(participant: string, content: Array<{ type: 'text'; text: string }>): void;
      }).addMessage('User', [{ type: 'text', text: 'must not append' }]);
      const after = await framework.getAgent('resident')!.compileContext();
      assert.doesNotMatch(JSON.stringify(after), /must not append/);

      await framework.stop();
      const reject = new RejectInferenceMembrane();
      framework = await AgentFramework.create({
        storePath,
        membrane: reject.asMembrane(),
        agents: [{
          name: 'resident',
          model: 'test-model',
          systemPrompt: 'test',
          strategy: new AlwaysQueuedStrategy(),
        }],
        modules: [new ApiModule()],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 10,
      });
      assert.equal(framework.getResidentLifecycleStatus('resident').status, 'retired');
      framework.start();
      framework.pushEvent({ type: 'api:message', participant: 'User', content: 'restart wake' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(reject.calls, 0);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps live-only module tools off programmatic and puppet paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-live-tool-'));
    const membrane = new LiveToolMembrane();
    const liveModule = new LiveOnlyModule();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'test' }],
      modules: [liveModule],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    try {
      const preview = await framework.previewActivation('resident');
      assert.ok(preview.tools?.some((tool) => tool.name === 'resident--lifecycle'));
      const direct = await framework.executeToolCall({
        id: 'direct',
        name: 'resident--lifecycle',
        callerAgentName: 'resident',
        input: {},
      });
      assert.equal(direct.success, false);
      assert.match(direct.error ?? '', /provider-issued live agent stream/);
      await assert.rejects(
        framework.puppetToolCall('resident', 'resident--lifecycle', {}),
        /restricted to a provider-issued live stream/,
      );
      framework.nudgeAgent('resident', 'live-tool-test');
      await framework.runUntilIdle();
      assert.equal(membrane.calls, 1);
      assert.equal(liveModule.handled, 1, 'the same tool dispatches from a real resident stream');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to create a conversation fork from a retired template resident', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-retired-template-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new RejectInferenceMembrane().asMembrane(),
      agents: [{
        name: 'template',
        model: 'test-model',
        systemPrompt: 'test',
        retirement: { enabled: true },
      }],
      modules: [],
      conversations: { templateAgent: 'template' },
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    try {
      framework.retireResident('template');
      await assert.rejects(
        (framework as unknown as {
          createConversationAgent(name: string, channel: string): Promise<unknown>;
        }).createConversationAgent('conversation-dm-g1', 'dm'),
        /template resident "template" is retired/,
      );
      assert.equal(framework.getAgent('conversation-dm-g1'), null);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on torn, malformed, semantically invalid, and duplicate seal records', async () => {
    const cases = [
      { name: 'torn', content: '{"version":1', message: /incomplete final record/ },
      { name: 'malformed', content: '{not json}\n', message: /Invalid retirement seal/ },
      {
        name: 'invalid',
        content: '{"version":1,"kind":"resident-retired","agentName":"resident","retiredAt":1,"reason":7}\n',
        message: /invalid retirement record/,
      },
      {
        name: 'duplicate',
        content:
          '{"version":1,"kind":"resident-retired","agentName":"resident","retiredAt":1}\n' +
          '{"version":1,"kind":"resident-retired","agentName":"resident","retiredAt":2}\n',
        message: /invalid retirement record/,
      },
    ];
    for (const testCase of cases) {
      const dir = mkdtempSync(join(tmpdir(), `af-retirement-${testCase.name}-`));
      const storePath = join(dir, 'store');
      const seed = await AgentFramework.create({
        storePath,
        membrane: new RejectInferenceMembrane().asMembrane(),
        agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'test' }],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 0,
      });
      await seed.stop();
      mkdirSync(storePath, { recursive: true });
      writeFileSync(join(storePath, 'resident-retirements.jsonl'), testCase.content);
      try {
        await assert.rejects(
          AgentFramework.create({
            storePath,
            membrane: new RejectInferenceMembrane().asMembrane(),
            agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'test' }],
            modules: [],
          }),
          testCase.message,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('requires a branch-independent seal path for app-owned stores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-resident-retirement-owned-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    try {
      await assert.rejects(
        AgentFramework.create({
          store,
          membrane: new RejectInferenceMembrane().asMembrane(),
          agents: [{
            name: 'resident',
            model: 'test-model',
            systemPrompt: 'test',
            retirement: { enabled: true },
          }],
          modules: [],
        }),
        /app-owned store without retirementPath/,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
