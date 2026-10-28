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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function withReaderFixture(
  check: (framework: AgentFramework, membrane: MockMembrane, tool: ToolModule) => Promise<void>,
  residentAllowedTools: 'all' | string[] = ['think'],
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dendrite-reader-permission-'));
  const statusPath = join(dir, 'status.jsonl');
  const commandPath = join(dir, 'commands.txt');
  writeFileSync(statusPath, '');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  const tool = new ToolModule('stub', 'frontline');
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'scout', model: 'test-model', systemPrompt: 'You are scout.',
        strategy: strategy(), allowedTools: residentAllowedTools,
      }],
      modules: [tool],
      subconscious: {
        enabled: true, reader: 'forks', model: 'test-model',
        voice: 'Read for scout.', strategyFactory: strategy,
      },
      mcplServers: [{
        id: 'disc', command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs')],
        env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath },
      }],
    });
    await framework.start();
    await check(framework, membrane, tool);
  } finally {
    if (framework) await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function restrictedReader(framework: AgentFramework) {
  return framework.deriveAgent({
    name: 'reader-a', from: 'scout', mode: 'copy', kind: 'subconscious-fork',
    framing: [{ participant: 'user', content: [{ type: 'text', text: 'Read and report.' }] }],
  });
}

const displayed = (request: { tools?: Array<{ name: string; description: string; inputSchema: unknown }> }) =>
  (request.tools ?? []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

describe('reader fork permission across resident tool lists', () => {
  it('keeps the resident tool display and dispatches only its own model call', async () => {
    await withReaderFixture(async (framework, membrane, tool) => {
      const residentTools = displayed(await framework.previewActivation('scout'));
      assert.ok(!residentTools.some((entry) => entry.name === 'note_disposition'),
        'premise: the resident omits the reader reporting tool');
      const fork = await restrictedReader(framework);
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'own-note', name: 'note_disposition',
          input: { key: 'reader-report', text: 'Read the channel' } },
        { type: 'tool_use', id: 'other-call', name: 'stub--frontline', input: {} },
      ] as never, 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done' }]));
      await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);

      const readerRequest = membrane.calls.find((call) => call.assistantParticipant === 'reader-a');
      assert.ok(readerRequest, 'premise: the reader made a model request');
      assert.deepEqual(displayed(readerRequest), residentTools,
        'the reader sees the same tool definitions as the resident');
      const outcomes = (membrane.lastStream?.receivedToolResults.flat() ?? []) as Array<{
        toolUseId: string; content: string; isError?: boolean;
      }>;
      const own = outcomes.find((result) => result.toolUseId === 'own-note');
      const other = outcomes.find((result) => result.toolUseId === 'other-call');
      assert.ok(own, 'the reader own call got a result');
      assert.equal(own.isError, false, 'the reader own call dispatches despite allowedTools');
      assert.match(own.content, /reader-report/, 'the disposition was actually recorded');
      assert.ok(other, 'the other call got a result');
      assert.equal(other.isError, true, 'a resident tool is refused for the reader');
      assert.deepEqual(tool.calls, [], 'the other tool did not run');
    });
  });

  for (const { label, allowedTools } of [
    { label: 'unrestricted', allowedTools: 'all' as const },
    { label: 'restricted', allowedTools: ['think'] },
  ]) {
    it('gives host-origin calls as the running reader the same own-only permission with ' + label + ' resident', async () => {
      await withReaderFixture(async (framework, membrane, tool) => {
        const hostCalls: Array<Promise<ToolResult>> = [];
        const modelRefusals: string[] = [];
        framework.onTrace((event) => {
          if (event.type !== 'tool:failed' || event.module !== 'dendrite'
              || event.callId !== 'model-other') return;
          modelRefusals.push(event.tool);
          hostCalls.push(framework.executeToolCall({
            id: 'host-other', name: 'stub--frontline', input: {}, callerAgentName: 'reader-a',
          }));
          hostCalls.push(framework.executeToolCall({
            id: 'host-own', name: 'note_disposition',
            input: { key: 'host-reader-report', text: 'Keep this disposition' },
            callerAgentName: 'reader-a',
          }));
        });
        const fork = await restrictedReader(framework);
        membrane.pushResponse(createMockResponse([
          { type: 'tool_use', id: 'model-other', name: 'stub--frontline', input: {} },
        ] as never, 'tool_use'));
        membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done' }]));
        await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
        assert.deepEqual(modelRefusals, ['stub--frontline'], 'premise: the model call reached the registered reader rule');
        assert.equal(hostCalls.length, 2, 'premise: both host calls began while the reader was running');
        const [other, own] = await Promise.all(hostCalls);
        assert.equal(other!.success, false, 'the host cannot run the resident tool as the reader');
        assert.match(other!.error ?? '', /not available to reader-a/,
          'the refusal belongs to the reader rule, not an unregistered caller');
        assert.deepEqual(tool.calls, [], 'the refused host and model calls have no effect');
        assert.equal(own!.success, true, 'the host can run the reader own tool as the reader: ' + JSON.stringify(own));
        assert.deepEqual(own!.data, { noted: 'host-reader-report' });
      }, allowedTools);
    });
  }
});
