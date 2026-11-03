/**
 * The usage record keeps every ephemeral agent's usage in one shared entry.
 * Each ephemeral agent runs under a new name, and framework/state is
 * rewritten whole after every inference, so an entry per name made every
 * later write bigger for good: 136 bytes per agent ever run, 272 KB a write
 * after 2,000.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, EventResponse, Module, ModuleContext, ProcessEvent, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { EPHEMERAL_USAGE_NAME } from '../src/usage/usage-tracker.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

type StoredUsage = { byAgent: Array<{ agentName: string; ephemeral?: true; inferenceCount: number; usage: { inputTokens: number } }> };

/** Hands a resident each external message, and asks it to answer. */
class InputModule implements Module {
  readonly name = 'input';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const resident = (name = 'resident'): AgentConfig => ({ name, model: 'test-model', systemPrompt: 'You are the resident.' });

function tempStore(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'ephemeral-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store.chronicle');
}

async function frameworkOn(storePath: string, membrane: MockMembrane, agents: AgentConfig[] = [resident()], modules: Module[] = []) {
  const framework = await AgentFramework.create({ storePath, membrane: membrane.asMembrane(), modules, agents });
  framework.start();
  return framework;
}

/** One ephemeral agent run to the end of one inference, with the mock's one
 *  answer queued for it (a stream takes every answer queued). */
async function runEphemeral(framework: AgentFramework, membrane: MockMembrane, name: string): Promise<void> {
  const created = await framework.createEphemeralAgent({ name, model: 'test-model', systemPrompt: 'Do the task.' });
  created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
  await framework.runEphemeralToCompletion(created.agent, created.contextManager);
  created.cleanup();
}

const storedUsage = (framework: AgentFramework): StoredUsage =>
  (framework.getStore().getStateJson('framework/state') as { usage: StoredUsage }).usage;

describe('ephemeral agents share one usage entry', () => {
  it('however many run, the stored record holds one entry for them, so it stays the size it was, and a resident keeps its own', async (t) => {
    const membrane = new MockMembrane();
    const framework = await frameworkOn(tempStore(t), membrane, [resident()], [new InputModule()]);
    try {
      await runEphemeral(framework, membrane, 'spawn-a-1');
      const afterOne = JSON.stringify(storedUsage(framework)).length;
      for (const name of ['spawn-b-2', 'spawn-c-3', 'spawn-d-4']) await runEphemeral(framework, membrane, name);

      assert.deepEqual(storedUsage(framework).byAgent.map((a) => [a.agentName, a.ephemeral, a.inferenceCount, a.usage.inputTokens]), [
        [EPHEMERAL_USAGE_NAME, true, 4, 40],
      ]);
      // The counts grew by a digit at most; no entry was added.
      assert.ok(JSON.stringify(storedUsage(framework)).length - afterOne <= 3);

      // A resident's inference counts under its own name.
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello' }]));
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} } as unknown as ProcessEvent);
      await until(() => framework.getSessionUsage().inferenceCount === 5);
      assert.deepEqual(storedUsage(framework).byAgent.map((a) => [a.agentName, a.ephemeral, a.inferenceCount, a.usage.inputTokens]), [
        ['resident', undefined, 1, 10],
        [EPHEMERAL_USAGE_NAME, true, 4, 40],
      ]);
      const snapshot = framework.getSessionUsage();
      assert.equal(snapshot.totals.inputTokens, 50);
      assert.equal(snapshot.inferenceCount, 5);
    } finally {
      await framework.stop();
    }
  });

  it('folds the entries an earlier release stored per ephemeral agent into the shared one on restart, never a persistent agent\'s', async (t) => {
    const storePath = tempStore(t);
    // A resident named "former" leaves agents/former in the store, then goes
    // from the config.
    let membrane = new MockMembrane();
    let framework = await frameworkOn(storePath, membrane, [resident(), resident('former')]);
    await framework.stop();

    // Ephemeral agents leave subagent/<name>. "helper", "former", "conv-a" and
    // "Subconscious" share a name with a persistent agent: a configured one, a
    // resident from before, a conversation agent (conversations/conv-a), and
    // the subconscious, configured below.
    membrane = new MockMembrane();
    framework = await frameworkOn(storePath, membrane);
    for (const name of ['spawn-old-1', 'spawn-old-2', 'helper', 'former', 'conv-a', 'Subconscious']) {
      await runEphemeral(framework, membrane, name);
    }
    const store = framework.getStore();
    store.registerState({ id: 'conversations/conv-a/context', strategy: 'snapshot' });
    // What an earlier release stored: an entry per ephemeral agent's name, and
    // the shared entry as an earlier release writes it back, without its mark.
    const state = store.getStateJson('framework/state') as { usage: StoredUsage & Record<string, unknown> };
    const entry = (agentName: string, inputTokens: number, extra: { cache?: [number, number]; cost?: number; inferences?: number } = {}) => ({
      agentName,
      usage: {
        inputTokens,
        outputTokens: 1,
        cacheCreationTokens: extra.cache?.[0] ?? 0,
        cacheReadTokens: extra.cache?.[1] ?? 0,
        ...(extra.cost !== undefined ? { estimatedCost: { total: extra.cost, currency: 'USD' } } : {}),
      },
      inferenceCount: extra.inferences ?? 1,
    });
    state.usage.byAgent = [
      entry('spawn-old-1', 100, { cache: [10, 20], cost: 0.01 }),
      entry('spawn-old-2', 200, { cache: [0, 40], cost: 0.02 }),
      entry(EPHEMERAL_USAGE_NAME, 1000, { cost: 0.1, inferences: 5 }),
      entry('helper', 30), entry('former', 4), entry('conv-a', 6), entry('Subconscious', 7), entry('unknown', 5),
    ];
    // The totals and the count as that release kept them: the entries' sums.
    state.usage.totals = {
      inputTokens: 1352, outputTokens: 8, cacheCreationTokens: 10, cacheReadTokens: 60,
      estimatedCost: { total: 0.13, currency: 'USD' },
    };
    state.usage.inferenceCount = 12;
    store.setStateJson('framework/state', state);
    await framework.stop();

    framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      modules: [],
      agents: [resident(), resident('helper')],
      subconscious: { enabled: true, systemPrompt: 'You are the subconscious.' },
    });
    try {
      const byAgent = framework.getSessionUsage().byAgent;
      const byName = (rows: unknown[][]) => [...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      assert.deepEqual(byName(byAgent.map((a) => [a.agentName, a.ephemeral, a.inferenceCount, a.usage.inputTokens])), byName([
        // A configured agent's name, a resident's or a conversation agent's
        // namespace, the subconscious's name, and a name with no ephemeral
        // namespace each keep their entry.
        ['helper', undefined, 1, 30],
        ['former', undefined, 1, 4],
        ['conv-a', undefined, 1, 6],
        ['Subconscious', undefined, 1, 7],
        ['unknown', undefined, 1, 5],
        [EPHEMERAL_USAGE_NAME, true, 7, 1300],
      ]));
      // The fold keeps each entry's cache counts and cost.
      const shared = byAgent.find((a) => a.ephemeral)!.usage;
      assert.deepEqual([shared.outputTokens, shared.cacheCreationTokens, shared.cacheReadTokens, shared.estimatedCost?.currency], [3, 10, 60, 'USD']);
      assert.ok(Math.abs(shared.estimatedCost!.total - 0.13) < 1e-10);
      // It moves entries only: the totals and the count stay as stored.
      const { totals, inferenceCount } = framework.getSessionUsage();
      assert.deepEqual([totals.inputTokens, totals.outputTokens, totals.cacheCreationTokens, totals.cacheReadTokens, totals.estimatedCost?.currency, inferenceCount],
        [1352, 8, 10, 60, 'USD', 12]);
      assert.ok(Math.abs(totals.estimatedCost!.total - 0.13) < 1e-10);
    } finally {
      await framework.stop();
    }
  });

  it("keeps a configured subconscious's own name out of the fold, whatever it's called and whether or not it's enabled", async (t) => {
    const storePath = tempStore(t);
    // An ephemeral agent once ran as "Dreamer", leaving subagent/Dreamer.
    const membrane = new MockMembrane();
    let framework = await frameworkOn(storePath, membrane);
    await runEphemeral(framework, membrane, 'Dreamer');
    const store = framework.getStore();
    const state = store.getStateJson('framework/state') as { usage: StoredUsage & Record<string, unknown> };
    const usage = { inputTokens: 7, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 };
    // The subconscious named "Dreamer" kept its own entry.
    state.usage.byAgent = [{ agentName: 'Dreamer', usage, inferenceCount: 1 }];
    state.usage.totals = usage;
    state.usage.inferenceCount = 1;
    store.setStateJson('framework/state', state);
    await framework.stop();

    for (const enabled of [false, true]) {
      framework = await AgentFramework.create({
        storePath,
        membrane: new MockMembrane().asMembrane(),
        modules: [],
        agents: [resident()],
        subconscious: { enabled, name: 'Dreamer', systemPrompt: 'You are the subconscious.' },
      });
      try {
        assert.deepEqual(framework.getSessionUsage().byAgent.map((a) => [a.agentName, a.ephemeral, a.usage.inputTokens]), [['Dreamer', undefined, 7]], `enabled: ${enabled}`);
      } finally {
        await framework.stop();
      }
    }
  });

  it("an ephemeral run that stop() ends still counts what it used in the shared entry", { timeout: 20_000 }, async (t) => {
    // Its stream is cancelled at the run's end and counts the round it
    // finished afterwards, once the run's own record is gone.
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => { started = resolve; });
    class HoldingModule implements Module {
      readonly name = 'test';
      async start(_ctx: ModuleContext): Promise<void> {}
      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] {
        return [{ name: 'hold', description: 'Hold until the run ends', inputSchema: { type: 'object', properties: {} } }];
      }
      async handleToolCall(_call: ToolCall): Promise<ToolResult> {
        started();
        return new Promise<ToolResult>(() => {});
      }
      async onProcess() { return {}; }
    }
    const membrane = new MockMembrane();
    const framework = await frameworkOn(tempStore(t), membrane, [resident()], [new HoldingModule()]);
    const created = await framework.createEphemeralAgent({ name: 'spawn-held-1', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'call-1', name: 'test--hold', input: {} }], 'tool_use'));
    const run = framework.runEphemeralToCompletion(created.agent, created.contextManager);
    run.catch(() => {});
    await toolStarted;
    await framework.stop();
    await assert.rejects(run);

    assert.deepEqual(framework.getSessionUsage().byAgent.map((a) => [a.agentName, a.ephemeral, a.inferenceCount, a.usage.inputTokens, a.usage.outputTokens]), [
      [EPHEMERAL_USAGE_NAME, true, 1, 10, 5],
    ]);
  });
});
