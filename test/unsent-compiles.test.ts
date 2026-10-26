/**
 * Compiles that are never sent are dry runs.
 *
 * A committing compile commits fold resolutions and queues compression work.
 * Agent-framework also moves the agent's consumed watermark (RFC-006) and
 * settles a prepared budget change at a full compile. With the thinking
 * binding (`thinkingBinding.binds`), a committing compile also writes the
 * context manager's binding record, which a compile never sent would leave
 * vouching for a request nobody made. Previews and the API's message
 * list and context are never sent, so each compiles as a dry run.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, type ContextManager } from '@animalabs/context-manager';
import type { Membrane } from '@animalabs/membrane';
import { AgentFramework, ApiServer } from '../src/index.js';
import { Agent } from '../src/agent.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { covers } from '../src/read-marks.js';

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
  it('a preview is a dry run, with or without gathered injections; a request that is sent is not', async () => {
    const x = await make();
    try {
      const agent = x.framework.getAgent('agent')!;
      const dry = recordCompiles(agent.getContextManager());
      await x.framework.previewActivation('agent');
      await x.framework.previewActivation('agent', { injections: true });
      await x.framework.previewActivation('agent', { budget: { maxTokens: 50_000, reserveForResponse: 4_000 } });
      // The control: the assembly a sent request goes through (as
      // startStreamWithInjections calls it) commits.
      await agent.buildActivationRequest([]);
      assert.deepEqual(dry, [true, true, true, false]);
    } finally { await x.close(); }
  });

  it('a preview leaves the consumed watermark: the agent never read what it assembled', async () => {
    const x = await make();
    try {
      const agent = x.framework.getAgent('agent')!;
      const before = agent.getConsumedWatermark();
      const id = agent.getContextManager().addMessage('user', [{ type: 'text', text: 'not yet read' }]);
      await x.framework.previewActivation('agent');
      assert.deepEqual(agent.getConsumedWatermark(), before);
      // The control: a request that is sent assembled it, so it's read.
      await agent.buildActivationRequest([]);
      const sequence = agent.getContextManager().getMessage(id)!.sequence;
      assert.equal(covers(agent.getConsumedWatermark(), agent.getContextManager(), { id, sequence }), 'covered', 'a sent request moves the watermark past what it assembled');
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
      // A sent compile first, so the frontier it records already fits the
      // window the lowered budget prepares: the descent is prepared before
      // the preview runs, and only the dry run keeps the preview from
      // settling it.
      await x.framework.getAgent('agent')!.buildActivationRequest([]);
      assert.equal(x.framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 }).transition, 'converging');
      assert.equal(x.framework.getAgent('agent')!.getContextManager().getHotContextSettings()?.prepared, true);
      await x.framework.previewActivation('agent');
      assert.equal(x.framework.getAgentRuntimeSettings('agent').transition, 'converging', 'a preview settles nothing');
      // The control: the assembly a sent request goes through settles it.
      await x.framework.getAgent('agent')!.buildActivationRequest([]);
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

  it("a kv-unified preview carries the immutable prefix hash and the dry run together; a sent request carries the hash alone", async () => {
    const options: unknown[] = [];
    const cm = {
      getStrategy: () => ({ isKvUnifiedEnabled: () => true }),
      setToolDefinitions: () => {},
      compile: async (_budget: unknown, _injections: unknown, opts: unknown) => {
        options.push(opts);
        return { messages: [{ participant: 'user', content: [{ type: 'text', text: 'hello' }] }], systemInjections: [] };
      },
    } as unknown as ContextManager;
    const agent = new Agent({ name: 'resident', model: 'test', systemPrompt: 'system' }, cm, {} as Membrane);
    await agent.buildActivationRequest([], undefined, undefined, [], { dryRun: true });
    await agent.buildActivationRequest([]);
    const [preview, sent] = options as Array<{ kvUnifiedImmutablePrefixHash?: unknown; dryRun?: unknown }>;
    assert.equal(typeof preview.kvUnifiedImmutablePrefixHash, 'string');
    assert.equal(preview.dryRun, true);
    assert.equal(sent.kvUnifiedImmutablePrefixHash, preview.kvUnifiedImmutablePrefixHash, 'both compile against the same prefix');
    assert.equal(sent.dryRun, undefined);
  });
});
