/**
 * A reader fork with channel speech off calls only its own tools: every
 * other call is refused at dispatch, whether the tool is in the resident's
 * tool list or not (the host's built-in toolset, a module's tool placed
 * there, a module utility called by its own name) and whether it existed
 * when the fork was derived or arrived after.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers/reader-fork-rig.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import type { Module, ModuleContext, ToolCall, ToolResult, ToolDefinition } from '../src/types/index.js';

/** A module with a tool it places in the built-in toolset and a utility. */
class StubModule implements Module {
  readonly name = 'stub';
  calls: ToolCall[] = [];
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'adminish', description: 'An administrative tool.', inputSchema: { type: 'object' } }];
  }
  getUtilities(): ToolDefinition[] {
    return [{ name: 'rare_op', description: 'A rarely-used operation.', inputSchema: { type: 'object' } }];
  }
  toolPlacement(name: string): 'header' | 'builtin' | undefined {
    return name === 'adminish' ? 'builtin' : undefined;
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { success: true, data: { handled: call.name } };
  }
  async onProcess(): Promise<any> { return {}; }
}

/** A module added once the fork exists. */
class LateModule implements Module {
  readonly name = 'late';
  calls: ToolCall[] = [];
  startedAt: number | undefined;
  calledAt: number | undefined;
  async start(_ctx: ModuleContext): Promise<void> { this.startedAt = Date.now(); }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'op', description: 'A tool added after the fork was derived.', inputSchema: { type: 'object' } }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    this.calledAt ??= Date.now();
    return { success: true, data: { handled: call.name } };
  }
  async onProcess(): Promise<any> { return {}; }
}

const use = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} });

describe('reader forks and tools out of the tool list', () => {
  const stub = new StubModule();
  const late = new LateModule();
  const r = rig('host-toolsets', false, { modules: [stub] });

  it('refuses every call outside its own tools, a tool added after derivation included', async () => {
    const before = await r.tuneOut();
    let lateAdded: Promise<void> | undefined;
    const refusedAt = new Map<string, number>();
    r.state.framework!.onTrace((event) => {
      if (event.type === 'tune-out:reader-fork' && !lateAdded) lateAdded = r.state.framework!.addModule(late);
      if (event.type === 'tool:failed' && (event as { module: string }).module === 'dendrite') {
        refusedAt.set((event as { tool: string }).tool, Date.now());
      }
    });
    r.state.membrane.push('reader',
      createMockResponse([
        use('c1', 'agent_settings'),
        use('c2', 'stub--adminish'),
        use('c3', 'stub--rare_op'),
      ] as never, 'tool_use'),
      createMockResponse([use('c4', 'late--op')] as never, 'tool_use'),
      createMockResponse([{ type: 'text', text: 'nothing urgent' }]));
    r.state.membrane.push('resident', createMockResponse([{ type: 'text', text: 'thanks' }]));
    r.emit('addressed', 'm1', 'hey scout, quick question');
    await r.waitFor(() => r.forkTraces().length >= 1, 'a reader fork is derived');
    const fork = r.forkTraces()[0]!.agentName;
    await r.waitFor(() => r.state.framework!.getAgentRecord(fork)?.ended !== undefined, 'the fork ends');
    await lateAdded;

    assert.ok(late.startedAt !== undefined, 'premise: the late module started');
    const lateCalled = late.calledAt ?? refusedAt.get('late--op');
    assert.ok(lateCalled !== undefined && late.startedAt! <= lateCalled, 'premise: the late module was there before its tool was called');
    assert.deepEqual(
      ['agent_settings', 'stub--adminish', 'stub--rare_op', 'late--op'].filter((t) => !refusedAt.has(t)),
      [],
      'each call outside the fork\'s own tools is refused at dispatch',
    );
    assert.deepEqual(stub.calls.map((c) => c.name), [], 'the built-in toolset\'s module tool and the utility never ran');
    assert.deepEqual(late.calls.map((c) => c.name), [], 'the tool added after derivation never ran');
    assert.equal(r.published().length - before, 0, 'nothing of the fork\'s reached the channel');
    await r.state.framework!.runUntilIdle();
  });
});
