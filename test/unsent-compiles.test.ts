/**
 * Compiles that are never sent are dry runs.
 *
 * A committing compile commits fold resolutions and queues compression work.
 * Agent-framework also moves the agent's consumed watermark (RFC-006) and
 * settles a prepared budget change at a full compile. With context-manager's
 * thinking binding (#155), a committing compile also commits stamps and joins
 * the branch's compiles awaiting acceptance, where one never sent can fence
 * the replies of a live stream. Previews and the API's message list and
 * context are never sent, so each compiles as a dry run.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, type ContextManager } from '@animalabs/context-manager';
import { AgentFramework, ApiServer } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

async function make(agent: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'unsent-compiles-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', ...agent }],
    modules: [],
  });
  return {
    framework,
    async close() { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Record whether each compile on `cm` is a dry run. */
function recordCompiles(cm: ContextManager): boolean[] {
  const dry: boolean[] = [];
  const original = cm.compile.bind(cm);
  (cm as unknown as { compile: (...args: unknown[]) => unknown }).compile = (...args: unknown[]) => {
    dry.push((args[2] as { dryRun?: boolean } | undefined)?.dryRun === true);
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  return dry;
}

describe('compiles that are never sent', () => {
  it('a preview is a dry run, with or without gathered injections', async () => {
    const x = await make();
    try {
      const dry = recordCompiles(x.framework.getAgent('agent')!.getContextManager());
      await x.framework.previewActivation('agent');
      await x.framework.previewActivation('agent', { injections: true });
      await x.framework.previewActivation('agent', { budget: { maxTokens: 50_000, reserveForResponse: 4_000 } });
      assert.deepEqual(dry, [true, true, true]);
    } finally { await x.close(); }
  });

  it('a preview leaves the consumed watermark: nobody read what it assembled', async () => {
    const x = await make();
    try {
      const agent = x.framework.getAgent('agent')!;
      const before = agent.getConsumedWatermark();
      agent.getContextManager().addMessage('user', [{ type: 'text', text: 'not yet read' }]);
      await x.framework.previewActivation('agent');
      assert.deepEqual(agent.getConsumedWatermark(), before);
    } finally { await x.close(); }
  });

  it('a preview leaves a prepared budget change for the compile that is sent', async () => {
    const x = await make({
      strategy: new AutobiographicalStrategy({
        adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000, kvStableReachTokens: 8_000,
      }),
      contextBudgetTokens: 100_000,
      maxTokens: 10_000,
    });
    try {
      assert.equal(x.framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 }).transition, 'converging');
      await x.framework.previewActivation('agent');
      assert.equal(x.framework.getAgentRuntimeSettings('agent').transition, 'converging', 'a preview settles nothing');
      // The control: a compile that is sent does settle it.
      await x.framework.getAgent('agent')!.compileWithInjections();
      assert.equal(x.framework.getAgentRuntimeSettings('agent').transition, 'stable');
    } finally { await x.close(); }
  });

  it("the API's message list and agent context are dry runs", async () => {
    const x = await make();
    try {
      const dry = recordCompiles(x.framework.getAgent('agent')!.getContextManager());
      const server = new ApiServer(x.framework, { port: 0, host: '127.0.0.1' }) as unknown as {
        cmdMessageList(params?: unknown): Promise<unknown>;
        cmdAgentContext(params: unknown): Promise<unknown>;
      };
      await server.cmdMessageList({});
      await server.cmdAgentContext({ agentName: 'agent' });
      await server.cmdAgentContext({ agentName: 'agent', maxTokens: 50_000 });
      assert.deepEqual(dry, [true, true, true]);
    } finally { await x.close(); }
  });
});
