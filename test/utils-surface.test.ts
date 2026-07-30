// The utils meta-tool: rarely-used capabilities live behind ONE slot
// (Module.getUtilities) instead of each taxing every inference with a schema.
// list/describe/run, arg validation that teaches by bounce, and dispatch that
// arrives at the module's ordinary handleToolCall.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AutobiographicalStrategy } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ToolCall, ToolResult, ToolDefinition } from '../src/types/index.js';

const membrane = {} as any;

function strategy(): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    recentWindowTokens: 30_000,
    kvStableReachTokens: 8_000,
  });
}

/** A module with one first-class tool and two utilities, sharing a handler. */
class StubModule implements Module {
  readonly name = 'stub';
  calls: ToolCall[] = [];
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'frontline', description: 'Always-on tool.', inputSchema: { type: 'object' } }];
  }
  getUtilities(): ToolDefinition[] {
    return [
      {
        name: 'rare_op',
        description: 'A rarely-used operation. Second sentence with detail.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['soft', 'hard'] },
            count: { type: 'number' },
          },
          required: ['mode'],
        },
      },
      { name: 'other_op', description: 'Another one.', inputSchema: { type: 'object' } },
    ];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { success: true, data: { handled: call.name, input: call.input } };
  }
  async onProcess(): Promise<any> {
    return {};
  }
}

async function makeFramework(modules: Module[]): Promise<{ framework: AgentFramework; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'utils-surface-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 100_000,
      maxTokens: 10_000,
    }],
    modules,
  });
  return { framework, dir };
}

describe('utils surface', () => {
  it('utils tool appears only when a module contributes utilities', async () => {
    const bare = await makeFramework([]);
    try {
      assert.ok(!bare.framework.getAllTools().some((t) => t.name === 'utils'),
        'no utilities → no utils tool, surface unchanged');
    } finally { await bare.framework.stop(); rmSync(bare.dir, { recursive: true, force: true }); }

    const stub = new StubModule();
    const { framework, dir } = await makeFramework([stub]);
    try {
      const tools = framework.getAllTools();
      assert.ok(tools.some((t) => t.name === 'utils'), 'utilities present → utils tool exposed');
      assert.ok(tools.some((t) => t.name === 'stub--frontline'), 'first-class tools unaffected');
      assert.ok(!tools.some((t) => t.name === 'stub--rare_op'),
        'utilities do NOT appear as first-class tools');
    } finally { await framework.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('list / describe / run round-trip through the ordinary module handler', async () => {
    const stub = new StubModule();
    const { framework, dir } = await makeFramework([stub]);
    try {
      const call = (input: unknown): Promise<ToolResult> =>
        framework.executeToolCall({ id: 'c1', name: 'utils', input, callerAgentName: 'agent' });

      const list = await call({ action: 'list' });
      assert.ok(list.success);
      assert.deepEqual(list.data, [
        { name: 'stub--rare_op', description: 'A rarely-used operation.' },
        { name: 'stub--other_op', description: 'Another one.' },
      ]);

      const desc = await call({ action: 'describe', name: 'stub--rare_op' });
      assert.ok(desc.success);
      assert.equal((desc.data as ToolDefinition).inputSchema.required?.[0], 'mode');

      const run = await call({ action: 'run', name: 'stub--rare_op', args: { mode: 'soft', count: 2 } });
      assert.ok(run.success, run.error);
      assert.deepEqual(run.data, { handled: 'rare_op', input: { mode: 'soft', count: 2 } });
      assert.equal(stub.calls[0]!.name, 'rare_op', 'module sees the un-prefixed name, as with tools');
      assert.equal(stub.calls[0]!.callerAgentName, 'agent');
    } finally { await framework.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('arg misses teach by bounce: schema rides the error', async () => {
    const stub = new StubModule();
    const { framework, dir } = await makeFramework([stub]);
    try {
      const call = (input: unknown): Promise<ToolResult> =>
        framework.executeToolCall({ id: 'c2', name: 'utils', input, callerAgentName: 'agent' });

      const missing = await call({ action: 'run', name: 'stub--rare_op', args: {} });
      assert.ok(!missing.success && missing.isError);
      assert.match(missing.error!, /missing required "mode"/);
      assert.match(missing.error!, /"enum":\["soft","hard"\]/, 'schema included for the retry');

      const badEnum = await call({ action: 'run', name: 'stub--rare_op', args: { mode: 'loud' } });
      assert.match(badEnum.error!, /"mode" must be one of \["soft","hard"\]/);

      const badType = await call({ action: 'run', name: 'stub--rare_op', args: { mode: 'soft', count: 'three' } });
      assert.match(badType.error!, /"count" must be number, got string/);
      assert.equal(stub.calls.length, 0, 'handler never reached on a validation miss');

      const unknown = await call({ action: 'run', name: 'stub--nope', args: {} });
      assert.match(unknown.error!, /No utility "stub--nope"\. Available: stub--rare_op, stub--other_op/);

      const badAction = await call({ action: 'zap' });
      assert.match(badAction.error!, /action must be "list", "describe", or "run"/);
    } finally { await framework.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});
