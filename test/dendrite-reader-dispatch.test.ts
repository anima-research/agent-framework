/**
 * A reader fork (registry kind 'subconscious-fork') may call only its own
 * tools at dispatch: its resident's tools stay in its block for the shared
 * prefix and are refused, and so is a tool registered after the fork was
 * derived. Here at the agent level, with a copy-mode fork, so it runs on
 * stores and context managers without `derive`; the reader path itself is in
 * tune-out-reader-host-toolsets.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AutobiographicalStrategy } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ToolCall, ToolResult, ToolDefinition } from '../src/types/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const strategy = () => new AutobiographicalStrategy({
  adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000, kvStableReachTokens: 8_000,
});

class ToolModule implements Module {
  calls: ToolCall[] = [];
  constructor(readonly name: string, private readonly tool: string) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: this.tool, description: `The ${this.name} module's tool.`, inputSchema: { type: 'object' } }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { success: true, data: { handled: call.name } };
  }
  async onProcess(): Promise<any> { return {}; }
}

describe('a reader fork at dispatch', () => {
  it('refuses its resident\'s tools and one registered after it was derived, not its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dendrite-reader-dispatch-'));
    const membrane = new MockMembrane();
    const owner = new ToolModule('stub', 'frontline');
    const late = new ToolModule('late', 'op');
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', strategy: strategy() }],
      modules: [owner],
    });
    const refused: string[] = [];
    framework.onTrace((event) => {
      if (event.type === 'tool:failed' && (event as { module: string }).module === 'dendrite') refused.push((event as { tool: string }).tool);
    });
    try {
      await framework.start();
      const fork = await framework.deriveAgent({
        name: 'reader-a', from: 'scout', mode: 'copy', kind: 'subconscious-fork',
        framing: [{ participant: 'user', content: [{ type: 'text', text: 'Read the channel and report.' }] }],
      });
      await framework.addModule(late);
      assert.ok(framework.getAllTools().some((t) => t.name === 'late--op'), 'premise: the late tool is registered after the fork was derived');

      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'c1', name: 'stub--frontline', input: {} },
        { type: 'tool_use', id: 'c2', name: 'late--op', input: {} },
        { type: 'tool_use', id: 'c3', name: 'note_disposition', input: {} },
      ] as never, 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'nothing urgent' }]));
      await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);

      assert.deepEqual(refused.sort(), ['late--op', 'stub--frontline'], 'the resident\'s tool and the later one are refused at dispatch; its own is not');
      assert.deepEqual(owner.calls.map((c) => c.name), [], 'the resident\'s tool never ran');
      assert.deepEqual(late.calls.map((c) => c.name), [], 'the later tool never ran');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
