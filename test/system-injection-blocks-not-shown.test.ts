/**
 * A `system` injection's blocks that aren't text (agent-framework#421).
 *
 * The system prompt is text, and context-manager hands a system injection's
 * content to the agent as it came, whether an MCPL server or a module
 * injected it. Each block that isn't text reads as a line in its place, and
 * the operator is told once per server, or module, and namespace.
 *
 * Run: node --import tsx --test test/system-injection-blocks-not-shown.test.ts
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

const PNG = 'iVBORw0KGgoAAAANSUhEUg==';
const IMAGE = { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } };

/** The line the agent reads in place of a block of `type`. */
const notShown = (type: string): string => `[${type} block not shown: the system prompt carries text only.]`;

/** A module that injects `injections` and asks for a turn of `agent` at every event. */
class InjectionModule implements Module {
  constructor(readonly name: string, private readonly injections: unknown[]) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'No tools', isError: true }; }
  async onProcess(_event: ProcessEvent): Promise<EventResponse> { return { requestInference: ['agent'] }; }
  async gatherContext(_agentName: string): Promise<ContextInjection[]> { return this.injections as ContextInjection[]; }
}

function captureConsoleError(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  return lines;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, modules: Module[]) {
  const dir = mkdtempSync(join(tmpdir(), 'system-injection-blocks-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'base' }],
    modules,
  });
  t.after(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  /** One turn of the agent, as an event starts it; the request it sent. */
  const turn = async () => {
    membrane.pushResponse(createMockResponse([]));
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1);
    return membrane.calls[0]!;
  };
  return { framework, turn };
}

/** The non-text blocks of a request's messages, by participant. */
function mediaIn(messages: Array<{ participant: string; content: unknown }>): string[] {
  return messages.flatMap((m) => ((Array.isArray(m.content) ? m.content : []) as Array<{ type?: string }>)
    .filter((b) => b.type !== 'text')
    .map((b) => `${m.participant}:${b.type}`));
}

test("a server's system injection shows a line in place of each block that isn't text, in a preview and in a turn, and its operator is told once per server and namespace", async (t) => {
  const lines = captureConsoleError(t);
  const server = (id: string, contextInjections: unknown[], positions = ['system', 'afterUser']) => ({
    id,
    grant: new CapabilityGrant(new Set(positions.map((p) => `contextHooks.beforeInference.inject.${p}`)), []),
    sendBeforeInference: async () => ({ featureSet: 'doc', contextInjections }),
    sendInferenceLifecycle: () => {},
  });
  const editor = server('editor', [
    { namespace: 'notes', position: 'system', content: [
      { type: 'text', text: 'before' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
      { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' },
      { type: 'image', uri: 'https://example.com/a.png' },
      { type: 'text', text: 'after' },
    ] },
    // A namespace that isn't a plain token prints escaped, as a server's identifiers do.
    { namespace: 'my charts', position: 'system', content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] },
    { namespace: 'plain', position: 'system', content: [{ type: 'text', text: 'plain_text' }] },
    // Another position keeps its image, in the messages, and the operator isn't told.
    { namespace: 'attached', position: 'afterUser', content: [{ type: 'text', text: 'after_user' }, { type: 'image', data: PNG, mimeType: 'image/png' }] },
  ]);
  // A second server with a namespace of the same name is told of its own.
  const viewer = server('viewer', [{ namespace: 'notes', position: 'system', content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] }]);
  // A server not granted the system position has its injection left out with the grant's line, and isn't told of its blocks.
  const outsider = server('outsider', [{ namespace: 'outside', position: 'system', content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] }], ['afterUser']);
  const { framework, turn } = await fixture(t, [new InjectionModule('trigger', [])]);
  (framework as unknown as { hookOrchestrator: HookOrchestrator }).hookOrchestrator =
    new HookOrchestrator({ getAllServers: () => [editor, viewer, outsider] } as never, { validateInbound: () => {} } as never);

  const system = ['base', 'before', notShown('image'), notShown('audio'), notShown('image'), 'after', notShown('image'), 'plain_text', notShown('image')].join('\n');
  const told = (id: string, namespace: string) =>
    `[mcpl] ${id}: a system injection in namespace ${namespace} holds a block that isn't text, which the system prompt can't carry, ` +
    'so an agent given the injection reads a line in place of each such block; this line prints once per server and namespace while the host runs';
  const refused = '[mcpl] outsider: dropped beforeInference injection at position system — not in the effective grant (§10.8)';
  const once = [told('editor', 'notes'), told('editor', '"my\\u0020charts"'), told('viewer', 'notes'), refused];
  const preview = await framework.previewActivation('agent', { injections: true });
  assert.equal(preview.system, system);
  assert.deepEqual(mediaIn(preview.messages as never), ['system_context:attached:image']);
  assert.deepEqual(lines, once);

  const request = await turn();
  assert.equal(request.system, system);
  assert.deepEqual(mediaIn(request.messages as never), ['system_context:attached:image']);
  assert.deepEqual(lines, [...once, refused], 'told once; the grant refuses again');
});

test("a module's system injection shows the same lines, and its operator is told once per module and namespace", async (t) => {
  const lines = captureConsoleError(t);
  // Injections that print nothing come before ones that print, so passing one over mustn't end the loop.
  const notes = new InjectionModule('notes-module', [
    { namespace: 'plain', position: 'system', content: [{ type: 'text', text: 'plain_text' }] },
    { namespace: 'notes', position: 'system', content: [{ type: 'text', text: 'module_text' }, IMAGE] },
    { namespace: 'attached', position: 'afterUser', content: [IMAGE] },
    { namespace: 'my charts', position: 'system', content: [IMAGE] },
  ]);
  // A second module with a namespace of the same name is told of its own.
  const other = new InjectionModule('other-module', [{ namespace: 'notes', position: 'system', content: [IMAGE] }]);
  const { framework, turn } = await fixture(t, [notes, other]);

  const system = ['base', 'plain_text', 'module_text', notShown('image'), notShown('image'), notShown('image')].join('\n');
  const told = (name: string, namespace: string) =>
    `[${name}] gatherContext: a system injection in namespace ${namespace} holds a block that isn't text, which the system prompt can't carry, ` +
    'so an agent given the injection reads a line in place of each such block; this line prints once per module and namespace while the host runs';
  const once = [told('notes-module', 'notes'), told('notes-module', '"my\\u0020charts"'), told('other-module', 'notes')];
  const preview = await framework.previewActivation('agent', { injections: true });
  assert.equal(preview.system, system);
  assert.deepEqual(mediaIn(preview.messages as never), ['system_context:attached:image']);
  assert.deepEqual(lines, once);

  const request = await turn();
  assert.equal(request.system, system);
  assert.deepEqual(lines, once, 'told once');
});
