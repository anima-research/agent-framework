/**
 * Module.getSubconsciousTools: a module can offer tools on the subconscious
 * resident's surface, which otherwise has no residents' board and no utils.
 * The subconscious is created before modules are added, so the tools it may
 * use follow the modules registered now, including ones added or removed at
 * runtime, and its call reaches the module under its own name.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { Module, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

class AnswerModule implements Module {
  readonly calls: ToolCall[] = [];
  constructor(readonly name = 'body') {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  getUtilities(): ToolDefinition[] {
    return [{ name: 'answer', description: 'Answer the host.', inputSchema: { type: 'object', properties: {} } }];
  }
  getSubconsciousTools(): ToolDefinition[] {
    return [{ name: 'answer', description: 'Answer the host.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { success: true, data: { answered: call.callerAgentName } };
  }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

type Internals = {
  subconsciousAgentName: string | null;
  dispatchToolCall(agentName: string, call: ToolCall): void;
};

describe('Module.getSubconsciousTools', () => {
  let tempDir: string;
  let framework: AgentFramework;
  let answers: AnswerModule;
  let sub: string;
  let quiet: typeof console.log;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'subconscious-tools-'));
    answers = new AnswerModule();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
      modules: [answers],
    });
    sub = (framework as unknown as Internals).subconsciousAgentName!;
    quiet = console.log;
    console.log = () => {};
  });
  afterEach(async () => {
    console.log = quiet;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const surface = (agent: string) => framework.listToolClasses(agent).map((t) => t.tool);

  it('offers them on the subconscious surface, without utils, and not on the residents\' board', async () => {
    assert.ok(sub, 'a subconscious exists');
    const subTools = surface(sub);
    assert.ok(subTools.includes('body--answer'), `subconscious surface: ${subTools.join(', ')}`);
    assert.ok(!subTools.includes('utils'), 'no utils on the subconscious surface');
    const scoutTools = surface('scout');
    assert.ok(!scoutTools.includes('body--answer'), 'not a first-class resident tool');
    assert.ok(scoutTools.includes('utils'), 'the resident reaches it as a utility');
  });

  it('follows modules added and removed at runtime', async () => {
    await framework.addModule(new AnswerModule('late'));
    assert.ok(surface(sub).includes('late--answer'), 'added after boot');
    await framework.removeModule('late');
    assert.ok(!surface(sub).includes('late--answer'), 'withdrawn with its module');
    assert.ok(surface(sub).includes('body--answer'), 'the others stay');
  });

  it("reaches the module under the subconscious's own name, from its model or a puppet", async () => {
    // The model path: the subconscious emits the call, which travels as a
    // queued tool-call event (the event loop delivers it to the module).
    framework.start();
    (framework as unknown as Internals).dispatchToolCall(sub, { id: 'toolu_sub_1', name: 'body--answer', input: {} });
    for (let n = 0; n < 50 && answers.calls.length === 0; n++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(answers.calls.map((c) => ({ name: c.name, caller: c.callerAgentName, origin: c.origin })), [
      { name: 'answer', caller: sub, origin: undefined },
    ]);

    // And the puppet's on-surface check now admits it, marked as the operator's.
    const { result } = await framework.puppetToolCall(sub, 'body--answer', {});
    assert.equal(result.success, true, String(result.error));
    assert.deepEqual(answers.calls.map((c) => c.origin), [undefined, 'puppet']);
  });
});
