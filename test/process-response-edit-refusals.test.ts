/**
 * A module's process response is applied in order: its messages added,
 * edited and removed, then its state update and inference request
 * (applyProcessResponse). One that throws as it applies, such as at an edit
 * the store refuses, or a removal the store refuses, stops there:
 * what came before stays applied, the operation that threw may have taken
 * effect in part or whole, and the rest of it isn't, as before. A
 * line names the module and where it threw, and the other modules'
 * responses, a tool call's dispatch and the event's trace go on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import type { Module, ModuleContext, ProcessEvent, ProcessState, EventResponse, ToolDefinition, ToolCall, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];

/** A module that answers a `ping`, or a call of its `act` tool, with
 *  `onPing`, and records the calls its tool is given. */
class Responder implements Module {
  readonly name: string;
  ctx!: ModuleContext;
  onPing: EventResponse = {};
  calls: string[] = [];
  /** Resolves with the first call its tool is given. */
  readonly called: Promise<string>;
  private resolveCalled!: (id: string) => void;
  constructor(name: string) {
    this.name = name;
    this.called = new Promise((resolve) => { this.resolveCalled = resolve; });
  }
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return [{ name: 'act', description: 'Acts.', inputSchema: { type: 'object' } }]; }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call.id);
    this.resolveCalled(call.id);
    return { success: true, data: {} };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    const type = (event as { type: string }).type;
    return type === 'ping' || type === 'tool-call' ? this.onPing : {};
  }
}

async function harness(modules: Responder[]) {
  const dir = mkdtempSync(join(tmpdir(), 'process-edit-refusals-af-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
    modules,
    processLogging: { persist: true },
  });
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  const traces: Array<Record<string, unknown>> = [];
  framework.onTrace((e) => { traces.push(e as unknown as Record<string, unknown>); });
  const window = () => framework.getAgent('assistant')!.getContextManager().getAllMessages()
    .map((m) => `${m.participant}: ${m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join(' ')}`);
  return {
    framework, errors, traces, window,
    close: async () => {
      console.error = error;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a response that throws at a removal the store refuses stops there, and the other modules' responses still apply", async (t) => {
  const refused = new Responder('refused');
  const after = new Responder('after');
  const x = await harness([refused, after]); t.after(x.close);
  refused.onPing = { removeMessages: ['no-such-message'] };
  after.onPing = { addMessages: [{ participant: 'After', content: text('from after') }] };
  x.framework.pushEvent({ type: 'ping', source: 'test' } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  assert.ok(x.window().includes('After: from after'), x.window().join('\n'));
  assert.ok(x.errors.some((e) => e.startsWith("[process] refused's response to ping threw at the removal of no-such-message")), x.errors.join('\n'));
});

test("a response whose edit throws stops there, as before: its later edits and removals and its state update aren't applied", async (t) => {
  const refused = new Responder('refused');
  const x = await harness([refused]); t.after(x.close);
  const cm = x.framework.getAgent('assistant')!.getContextManager();
  const kept = cm.addMessage('Antra', text('before'));
  const gone = cm.addMessage('Antra', text('to remove'));
  refused.onPing = {
    editMessages: [
      { messageId: 'no-such-message', content: text('nowhere') },
      { messageId: kept, content: text('after') },
    ],
    removeMessages: [gone],
    stateUpdate: { seen: true },
  };
  x.framework.pushEvent({ type: 'ping', source: 'test' } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  const window = x.window();
  assert.ok(window.includes('Antra: before') && window.includes('Antra: to remove'), `nothing after the throw applied:\n${window.join('\n')}`);
  assert.ok(x.errors.some((e) => e.startsWith("[process] refused's response to ping threw at the edit of no-such-message")), x.errors.join('\n'));
  const registry = (x.framework as unknown as { moduleRegistry: { getModuleState(name: string): unknown } }).moduleRegistry;
  assert.equal(registry.getModuleState('refused'), null, 'its state update was not applied');
});

test("a response whose removals are applied in order keeps those before a throw, and not those after it", async (t) => {
  const refused = new Responder('refused');
  const x = await harness([refused]); t.after(x.close);
  const cm = x.framework.getAgent('assistant')!.getContextManager();
  const first = cm.addMessage('Antra', text('first'));
  const last = cm.addMessage('Antra', text('last'));
  refused.onPing = { removeMessages: [first, 'no-such-message', last], stateUpdate: { seen: true } };
  x.framework.pushEvent({ type: 'ping', source: 'test' } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  assert.deepEqual(x.window().filter((line) => line === 'Antra: first' || line === 'Antra: last'), ['Antra: last']);
  const registry = (x.framework as unknown as { moduleRegistry: { getModuleState(name: string): unknown } }).moduleRegistry;
  assert.equal(registry.getModuleState('refused'), null);
});

test("a response that throws while adding a message stops there, and the other modules' responses still apply", async (t) => {
  const refused = new Responder('refused');
  const after = new Responder('after');
  const x = await harness([refused, after]); t.after(x.close);
  const self = x.framework as unknown as { addMessage: (participant: string, content: ContentBlock[], metadata?: unknown) => string };
  const add = self.addMessage;
  self.addMessage = function (this: unknown, participant, content, metadata) {
    if (content.some((b) => (b as { text?: string }).text === 'second')) throw new Error('the store refused it');
    return add.call(this, participant, content, metadata);
  };
  refused.onPing = { addMessages: [{ participant: 'Antra', content: text('first') }, { participant: 'Antra', content: text('second') }, { participant: 'Antra', content: text('third') }] };
  after.onPing = { addMessages: [{ participant: 'After', content: text('from after') }] };
  try {
    x.framework.pushEvent({ type: 'ping', source: 'test' } as unknown as ProcessEvent);
    await x.framework.runUntilIdle();
  } finally { self.addMessage = add; }
  const window = x.window();
  assert.ok(window.includes('Antra: first') && !window.includes('Antra: third'), window.join('\n'));
  assert.ok(window.includes('After: from after'), window.join('\n'));
  assert.ok(x.errors.some((e) => e.startsWith("[process] refused's response to ping threw at adding message 2 of 3") && e.includes('the store refused it')), x.errors.join('\n'));
});

test("a response whose edits and removals all apply has its state update applied", async (t) => {
  const fine = new Responder('fine');
  const x = await harness([fine]); t.after(x.close);
  const cm = x.framework.getAgent('assistant')!.getContextManager();
  const kept = cm.addMessage('Antra', text('before'));
  const gone = cm.addMessage('Antra', text('to remove'));
  fine.onPing = { editMessages: [{ messageId: kept, content: text('after') }], removeMessages: [gone], stateUpdate: { seen: true } };
  x.framework.pushEvent({ type: 'ping', source: 'test' } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  const registry = (x.framework as unknown as { moduleRegistry: { getModuleState(name: string): unknown } }).moduleRegistry;
  assert.equal((registry.getModuleState('fine') as { seen?: boolean } | null)?.seen, true);
});

test("a tool-call event whose module's response throws at an edit still dispatches the call", async (t) => {
  const refused = new Responder('refused');
  const x = await harness([refused]); t.after(x.close);
  refused.onPing = { editMessages: [{ messageId: 'no-such-message', content: text('nowhere') }] };
  x.framework.pushEvent({
    type: 'tool-call',
    callId: 'c-act',
    agentName: 'assistant',
    moduleName: 'refused',
    toolName: 'act',
    call: { id: 'c-act', name: 'refused--act', input: {} },
  } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  assert.equal(await refused.called, 'c-act');
  assert.ok(x.errors.some((e) => e.startsWith("[process] refused's response to tool-call threw at the edit of no-such-message")), x.errors.join('\n'));
});
