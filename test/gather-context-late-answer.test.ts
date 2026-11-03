/**
 * What a turn's request carries from modules' gatherContext() when one
 * answers after its timeout, or throws before it returns a promise.
 *
 * A late answer was still pushed into the list the registry returns: before
 * it was returned, while a slower module was still awaited, or after it,
 * where a turn whose list another module had answered into kept it by
 * reference while it awaited the MCPL servers' beforeInference. Either way
 * it reached the turn's request. A module that threw left the registry's
 * gatherContext(), and the turn went without every module's injections.
 *
 * Run: node --import tsx --test test/gather-context-late-answer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextInjection } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { HookOrchestrator } from '../src/mcpl/hook-orchestrator.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

/** A module that injects one `system` text block after `delayMs`, and asks for a turn at every event. */
class DelayedModule implements Module {
  constructor(readonly name: string, private readonly delayMs: number, readonly contextTimeoutMs?: number) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'No tools', isError: true }; }
  async onProcess(_event: ProcessEvent): Promise<EventResponse> { return { requestInference: ['agent'] }; }
  async gatherContext(_agentName: string): Promise<ContextInjection[]> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return [{ namespace: this.name, position: 'system', content: [{ type: 'text', text: `${this.name}_text` }] }];
  }
}

test("a module's answer after its timeout doesn't reach the turn's request while an MCPL server is consulted", async (t) => {
  const errs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  const dir = mkdtempSync(join(tmpdir(), 'gather-context-late-answer-'));
  const membrane = new MockMembrane();
  // `late` times out at 50ms and answers at 120ms, while the server's
  // beforeInference, asked once the modules are gathered, answers 150ms
  // after that: timers fire in due order, so the late answer always comes
  // after the gather has returned and before the server answers, while the
  // turn holds the list `fast` answered into.
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'base' }],
    modules: [new DelayedModule('fast', 0), new DelayedModule('late', 120, 50)],
  });
  t.after(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const asked = { entered: 0, answered: 0 };
  const server = {
    id: 'srv',
    grant: new CapabilityGrant(new Set(['contextHooks.beforeInference.inject.system']), []),
    sendBeforeInference: async () => {
      asked.entered++;
      await new Promise((r) => setTimeout(r, 150));
      asked.answered++;
      return { featureSet: 'doc', contextInjections: [] };
    },
    sendInferenceLifecycle: () => {},
  };
  (framework as unknown as { hookOrchestrator: HookOrchestrator }).hookOrchestrator =
    new HookOrchestrator({ getAllServers: () => [server] } as never, { validateInbound: () => {} } as never);

  membrane.pushResponse(createMockResponse([]));
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
  await framework.runUntilIdle();
  assert.equal(membrane.calls.length, 1);
  assert.deepEqual(asked, { entered: 1, answered: 1 }, "the turn waited for the server's beforeInference");
  assert.equal(membrane.calls[0]!.system, ['base', 'fast_text'].join('\n'), 'the late answer is not in the request');
  assert.ok(errs.some((e) => e.includes('[late] gatherContext') && e.includes('timed out after 50ms')));
});

test("a module's answer after its timeout doesn't reach the turn's request while a slower module is still awaited", async (t) => {
  const errs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  const dir = mkdtempSync(join(tmpdir(), 'gather-context-late-pending-'));
  const membrane = new MockMembrane();
  // `late` times out at 50ms and answers at 120ms, while `slow`, in time on
  // its 1000ms budget, answers at 200ms; no MCPL server is consulted.
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'base' }],
    modules: [new DelayedModule('late', 120, 50), new DelayedModule('slow', 200, 1000)],
  });
  t.after(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  membrane.pushResponse(createMockResponse([]));
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
  await framework.runUntilIdle();
  assert.equal(membrane.calls.length, 1);
  assert.equal(membrane.calls[0]!.system, ['base', 'slow_text'].join('\n'), 'the late answer is not in the request');
  assert.ok(errs.some((e) => e.includes('[late] gatherContext') && e.includes('timed out after 50ms')));
});

test("a module whose gatherContext throws before returning a promise leaves the other modules' injections in the turn's request", async (t) => {
  const errs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  const dir = mkdtempSync(join(tmpdir(), 'gather-context-throw-'));
  const membrane = new MockMembrane();
  const thrower = new DelayedModule('thrower', 0);
  thrower.gatherContext = (() => { throw new Error('no context today'); }) as DelayedModule['gatherContext'];
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'base' }],
    modules: [thrower, new DelayedModule('fast', 0)],
  });
  t.after(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  membrane.pushResponse(createMockResponse([]));
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
  await framework.runUntilIdle();
  assert.equal(membrane.calls.length, 1);
  assert.equal(membrane.calls[0]!.system, ['base', 'fast_text'].join('\n'), "the other module's injection is in the request");
  assert.ok(errs.some((e) => e.includes('[thrower] gatherContext') && e.includes('no context today')));
});
