import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DetailedUsage, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { HealthModule } from '../src/modules/health/index.js';
import type { Module, ToolCall, TraceEvent } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

class TurnTools implements Module {
  readonly name = 'test';
  async start() {}
  async stop() {}
  async onProcess() { return {}; }
  getTools() {
    return ['echo', 'finish'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' as const, properties: {} },
    }));
  }
  async handleToolCall(call: ToolCall) {
    return { success: true, endTurn: call.name.endsWith('finish'), data: {} };
  }
}

const firstUsage: DetailedUsage = {
  inputTokens: 100, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40,
  estimatedCost: { input: 0.01, output: 0.02, total: 0.03, currency: 'USD' },
};
const totalUsage: DetailedUsage = {
  inputTokens: 250, outputTokens: 55, cacheCreationTokens: 45, cacheReadTokens: 90,
  estimatedCost: { input: 0.03, output: 0.05, total: 0.08, currency: 'USD' },
};

function toolResponse(name: string, id: string, usage?: DetailedUsage): NormalizedResponse {
  const response = createMockResponse([{ type: 'tool_use', name: 'test--' + name, id, input: {} }], 'tool_use');
  // Membrane emits cumulative usage across all rounds of a yielding stream.
  response.usage = usage!;
  return response;
}

function expectedTokens(usage: DetailedUsage) {
  return {
    input: usage.inputTokens, output: usage.outputTokens,
    cacheCreation: usage.cacheCreationTokens, cacheRead: usage.cacheReadTokens,
  };
}

function expectedTotals(usage: DetailedUsage) {
  return {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    estimatedCost: usage.estimatedCost
      ? { total: usage.estimatedCost.total, currency: usage.estimatedCost.currency }
      : undefined,
  };
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'af-end-turn-usage-'));
  const storePath = join(dir, 'store.chronicle');
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath, membrane: membrane.asMembrane(), agents: [],
    modules: [new TurnTools()], syncIntervalMs: 0,
  });
  const traces: TraceEvent[] = [];
  const completionStates: Array<string | undefined> = [];
  framework.onTrace((event) => {
    traces.push(event);
    if (event.type === 'inference:completed') {
      completionStates.push(framework.getAgent(event.agentName)?.state.status);
    }
  });
  framework.start();
  return { dir, storePath, membrane, framework, traces, completionStates };
}

async function run(framework: AgentFramework, name: string) {
  const { agent, contextManager } = await framework.createEphemeralAgent({
    name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
    proseRouting: 'disabled',
  });
  contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
  const result = await framework.runEphemeralToCompletion(agent, contextManager);
  // Also observe asynchronous cancellation teardown before checking counts.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return result;
}

describe('tool-ended turn usage accounting', () => {
  for (const rounds of [1, 2]) {
    it('accounts once for ' + rounds + ' tool round(s), with cumulative cache usage and cost', async () => {
      const f = await fixture();
      try {
        if (rounds === 2) f.membrane.pushResponse(toolResponse('echo', 'echo-1', firstUsage));
        f.membrane.pushResponse(toolResponse('finish', 'finish-1', totalUsage));
        const result = await run(f.framework, 'worker');
        assert.equal(result.toolCallsCount, rounds);
        assert.equal(f.membrane.calls.length, 1, 'endTurn must not request another inference');
        assert.equal(f.membrane.lastStream!.receivedToolResults.length, rounds - 1);
        assert.deepEqual(f.completionStates, ['idle']);
        const completed = f.traces.filter((e) => e.type === 'inference:completed');
        assert.equal(completed.length, 1);
        assert.equal(completed[0].agentName, 'worker');
        assert.deepEqual(completed[0].tokenUsage, expectedTokens(totalUsage));
        assert.ok(completed[0].durationMs >= 0);
        const logs = f.framework.queryInferenceLogs({ agentName: 'worker' });
        assert.equal(logs.total, 1);
        assert.equal(logs.entries[0].entry.success, true);
        assert.equal(logs.entries[0].entry.stopReason, 'turn_ended');
        assert.deepEqual(logs.entries[0].entry.tokenUsage, expectedTokens(totalUsage));
        assert.deepEqual(logs.entries[0].entry.response, { note: 'stream ended by tool result' });
        assert.equal(logs.entries[0].entry.durationMs, completed[0].durationMs);
        assert.equal(f.traces.filter((e) => e.type === 'inference:turn_ended').length, 1);
        assert.equal(f.traces.filter((e) => e.type === 'usage:updated').length, 1);
        assert.equal(f.traces.filter((e) => e.type === 'inference:exhausted').length, 0);
        const snapshot = f.framework.getSessionUsage();
        assert.equal(snapshot.inferenceCount, 1);
        assert.deepEqual(snapshot.totals, expectedTotals(totalUsage));
        assert.deepEqual(snapshot.byAgent, [{
          agentName: 'worker', usage: expectedTotals(totalUsage), inferenceCount: 1,
        }]);
      } finally {
        await f.framework.stop();
        rmSync(f.dir, { recursive: true, force: true });
      }
    });
  }

  it('keeps natural completion authoritative and counts neither cumulative samples nor final usage twice', async () => {
    const f = await fixture();
    try {
      f.membrane.pushResponse(toolResponse('echo', 'echo-1', firstUsage));
      const response = createMockResponse([{ type: 'text', text: 'Done.' }]);
      response.usage = { ...totalUsage, outputTokens: 50 }; // final details remain authoritative
      response.details!.usage = totalUsage;
      f.membrane.pushResponse(response);
      await run(f.framework, 'ordinary');
      assert.deepEqual(f.completionStates, ['idle']);
      const completed = f.traces.filter((e) => e.type === 'inference:completed');
      assert.equal(completed.length, 1);
      assert.deepEqual(completed[0].tokenUsage, expectedTokens(totalUsage));
      assert.equal(f.traces.filter((e) => e.type === 'usage:updated').length, 1);
      assert.equal(f.traces.filter((e) => e.type === 'inference:turn_ended').length, 0);
      assert.equal(f.framework.getSessionUsage().inferenceCount, 1);
      assert.deepEqual(f.framework.getSessionUsage().totals, expectedTotals(totalUsage));
      const logs = f.framework.queryInferenceLogs({ agentName: 'ordinary' });
      assert.equal(logs.total, 1, 'natural completion logs exactly once');
      assert.equal(logs.entries[0].entry.stopReason, 'end_turn');
      assert.deepEqual(logs.entries[0].entry.tokenUsage, expectedTokens(totalUsage));
    } finally {
      await f.framework.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('attributes successive streams separately and persists their totals through store reopen', async () => {
    const f = await fixture();
    let stopped = false;
    try {
      f.membrane.pushResponse(toolResponse('finish', 'finish-a', firstUsage));
      await run(f.framework, 'alice');
      f.membrane.pushResponse(toolResponse('finish', 'finish-b', totalUsage));
      await run(f.framework, 'bob');
      const snapshot = f.framework.getSessionUsage();
      assert.equal(snapshot.inferenceCount, 2);
      assert.deepEqual(snapshot.byAgent, [
        { agentName: 'alice', usage: expectedTotals(firstUsage), inferenceCount: 1 },
        { agentName: 'bob', usage: expectedTotals(totalUsage), inferenceCount: 1 },
      ]);
      assert.deepEqual(f.traces.filter((e) => e.type === 'usage:updated').map((e) => e.agentName), ['alice', 'bob']);
      const logs = f.framework.queryInferenceLogs();
      assert.equal(logs.total, 2);
      assert.equal(new Set(logs.entries.map((e) => e.entry.requestId)).size, 2);
      assert.deepEqual(logs.entries.map((e) => e.entry.agentName).sort(), ['alice', 'bob']);
      await f.framework.stop();
      stopped = true;
      const reopened = await AgentFramework.create({
        storePath: f.storePath, membrane: f.membrane.asMembrane(), agents: [], modules: [], syncIntervalMs: 0,
      });
      try {
        assert.deepEqual(reopened.getSessionUsage(), snapshot);
        assert.deepEqual(reopened.queryInferenceLogs(), logs);
      } finally {
        await reopened.stop();
      }
    } finally {
      if (!stopped) await f.framework.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('includes tool-ended turns in the log-backed health snapshot', async () => {
    const f = await fixture();
    try {
      f.membrane.pushResponse(toolResponse('echo', 'echo-1', firstUsage));
      f.membrane.pushResponse(toolResponse('finish', 'finish-1', totalUsage));
      await run(f.framework, 'worker');
      const health = new HealthModule({ timeZone: 'UTC' });
      health.bind(f.framework, f.framework.getStore());
      const result = await health.handleToolCall({
        id: 'health-snapshot', name: 'snapshot', input: { includeSubagents: false },
      });
      assert.equal(result.success, true);
      const data = result.data as {
        inferences: { successCount: number; errorCount: number };
        tokenTotalsByAgent: Record<string, { input: number; output: number; cacheRead: number; inferences: number }>;
      };
      assert.equal(data.inferences.successCount, 1);
      assert.equal(data.inferences.errorCount, 0);
      assert.deepEqual(data.tokenTotalsByAgent.worker, {
        input: totalUsage.inputTokens, output: totalUsage.outputTokens,
        cacheRead: totalUsage.cacheReadTokens, inferences: 1,
      });
    } finally {
      await f.framework.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('reports completion without inventing usage when no sample is available', async () => {
    const f = await fixture();
    try {
      f.membrane.pushResponse(toolResponse('finish', 'finish-1'));
      await run(f.framework, 'unknown-usage');
      const completed = f.traces.filter((e) => e.type === 'inference:completed');
      assert.equal(completed.length, 1);
      assert.equal(completed[0].tokenUsage, undefined);
      assert.equal(f.traces.filter((e) => e.type === 'usage:updated').length, 0);
      assert.equal(f.framework.getSessionUsage().inferenceCount, 0);
      const logs = f.framework.queryInferenceLogs({ agentName: 'unknown-usage' });
      assert.equal(logs.total, 1);
      assert.equal(logs.entries[0].entry.success, true);
      assert.equal(logs.entries[0].entry.tokenUsage, undefined);
    } finally {
      await f.framework.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
