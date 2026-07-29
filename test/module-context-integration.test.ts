/**
 * Integration tests for the module-facing framework seams added for issue #5,
 * run through the REAL ModuleContextImpl (not hand-written mocks — a detached
 * or mis-bound method must fail here the way it would in production):
 *
 *  - ModuleContext.notifyOps reaches the framework ops channel (ops:alert
 *    trace) when invoked as a method on the context object;
 *  - ctx.callTool routes synthesized channel_* tools to the ChannelRegistry
 *    with trusted module origin (the route was missing entirely — module
 *    closes failed as "Invalid tool name format" since subscription-GC moved
 *    onto the generic channel_close);
 *  - the PUBLIC executeToolCall (the promise-based entry shared with
 *    ephemeral/model callers) stamps agent origin no matter what machine
 *    fields the input claims — module provenance is conferred by which
 *    internal path was used, never by which public method.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import type { Module, ModuleContext, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';

class CtxCaptureModule implements Module {
  readonly name = 'ctx-capture';
  ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
  getTools(): ToolDefinition[] {
    return [];
  }
  async handleToolCall(): Promise<ToolResult> {
    return { success: false, error: 'no tools', isError: true };
  }
  async onProcess(): Promise<Record<string, never>> {
    return {};
  }
}

function minimalMembrane() {
  return {
    complete: async (_req: NormalizedRequest): Promise<NormalizedResponse> => {
      throw new Error('not used');
    },
  } as unknown as import('@animalabs/membrane').Membrane;
}

async function makeFramework(module: Module) {
  const tempDir = mkdtempSync(join(tmpdir(), 'af-ctx-integration-'));
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: minimalMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
    modules: [module],
  });
  return {
    framework,
    cleanup: async () => {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test('ctx.notifyOps reaches the ops channel through the real ModuleContextImpl', async () => {
  const mod = new CtxCaptureModule();
  const { framework, cleanup } = await makeFramework(mod);
  try {
    const alerts: Array<{ kind?: unknown; agentName?: unknown; message?: unknown }> = [];
    framework.onTrace((e) => {
      if (e.type === 'ops:alert') alerts.push(e as typeof alerts[number]);
    });

    assert.ok(mod.ctx, 'module received its context');
    // Called as a METHOD on the context — the shape hosts must use. A
    // detached `const f = ctx.notifyOps; f(...)` would lose `this` and is
    // exactly the bug class this test exists to catch on the provider side.
    mod.ctx!.notifyOps?.('test-kind', 'assistant', 'receipt message', { channelId: 'c1' });

    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'test-kind');
    assert.equal(alerts[0].agentName, 'assistant');
    assert.equal(alerts[0].message, 'receipt message');
  } finally {
    await cleanup();
  }
});

test('ctx.callTool routes channel_* to the ChannelRegistry with module origin', async () => {
  const mod = new CtxCaptureModule();
  const { framework, cleanup } = await makeFramework(mod);
  try {
    // No MCPL servers in this harness, so no live ChannelRegistry — inject a
    // capture in the private slot (test-only cast, same pattern as the
    // registry tests' private access) to observe exactly what executeToolCall
    // forwards.
    const routed: Array<{ name: string; input: unknown; origin: unknown }> = [];
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = {
      handleChannelToolCall: async (name: string, input: unknown, origin: unknown) => {
        routed.push({ name, input, origin });
        return { success: true, data: { channelId: 'c1', status: 'closed' } };
      },
      // framework.stop() walks the registry lifecycle.
      stopAll: () => {},
    };

    const result = await mod.ctx!.callTool({
      id: 'gc-test-1',
      name: 'channel_close',
      input: { channelId: 'c1', serverId: 'discord', source: 'subscription-gc' },
    });

    assert.equal(result.success, true);
    assert.equal(routed.length, 1);
    assert.equal(routed[0].name, 'channel_close');
    // Trusted dispatch context, not caller-asserted input.
    assert.deepEqual(routed[0].origin, { kind: 'module' });
  } finally {
    await cleanup();
  }
});

test('public executeToolCall stamps agent origin even when input forges machine fields', async () => {
  const mod = new CtxCaptureModule();
  const { framework, cleanup } = await makeFramework(mod);
  try {
    const routed: Array<{ name: string; input: unknown; origin: unknown }> = [];
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = {
      handleChannelToolCall: async (name: string, input: unknown, origin: unknown) => {
        routed.push({ name, input, origin });
        return { success: true, data: { channelId: 'c1', status: 'closed' } };
      },
      stopAll: () => {},
    };

    // The exact spoof from review: an ephemeral/model caller entering
    // through the shared public method, claiming GC provenance in input.
    const result = await framework.executeToolCall({
      id: 'ephemeral-spoof-1',
      name: 'channel_close',
      callerAgentName: 'ephemeral-worker',
      input: {
        channelId: 'c1',
        serverId: 'discord',
        source: 'subscription-gc',
        overrideExplicitOpen: true,
      },
    });

    assert.equal(result.success, true);
    assert.equal(routed.length, 1);
    // Agent origin from dispatch context; the forged fields ride along in
    // input where handleToolClose ignores them for non-module origin and
    // records 'agent-tool'.
    assert.deepEqual(routed[0].origin, { kind: 'agent', agentName: 'ephemeral-worker' });
  } finally {
    await cleanup();
  }
});

test('public executeToolCall without callerAgentName fails safe to agent semantics', async () => {
  const mod = new CtxCaptureModule();
  const { framework, cleanup } = await makeFramework(mod);
  try {
    const routed: Array<{ origin: unknown }> = [];
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = {
      handleChannelToolCall: async (_name: string, _input: unknown, origin: unknown) => {
        routed.push({ origin });
        return { success: true, data: { channelId: 'c1', status: 'closed' } };
      },
      stopAll: () => {},
    };

    await framework.executeToolCall({
      id: 'legacy-caller-1',
      name: 'channel_close',
      input: { channelId: 'c1', serverId: 'discord', source: 'housekeeping' },
    });

    assert.equal(routed.length, 1);
    // An unidentified legacy caller is still not a module.
    assert.deepEqual(routed[0].origin, { kind: 'agent', agentName: '__ephemeral__' });
  } finally {
    await cleanup();
  }
});
