/**
 * `thinkingBinding.binds` says the agent's model binds its signed thinking to the conversation before it. Set, each
 * compile the agent sends, a framework turn's and the direct API's, tells the context manager so, with digests of
 * the request's head, the options a context manager that keeps a thinking-binding record reads. Unset, compiles
 * carry neither.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextInjection, ContextManager } from '@animalabs/context-manager';
import type { Membrane, NormalizedRequest } from '@animalabs/membrane';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent, AgentFramework } from '../src/index.js';
import type { AgentConfig, ToolDefinition } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

type Opts = { thinkingBinding?: { binds: boolean; dropBlock: boolean; participant: string }; identity?: Record<'system' | 'tools' | 'model' | 'request', string> } | undefined;

/** A context manager that records the options each compile is given. */
function recording(): { contextManager: ContextManager; seen: Opts[] } {
  const seen: Opts[] = [];
  const contextManager = {
    compile: async (_budget: unknown, injections: ContextInjection[] | undefined, opts: Opts) => {
      seen.push(opts);
      return {
        messages: [{ participant: 'user', content: [{ type: 'text', text: 'Hello.' }] }],
        systemInjections: (injections ?? []).filter((i) => i.position === 'system').flatMap((i) => i.content),
      };
    },
    addMessage: () => 'reply',
  } as unknown as ContextManager;
  return { contextManager, seen };
}
const tool = (name: string): ToolDefinition => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }) as ToolDefinition;
const config = (settings: Partial<AgentConfig>): AgentConfig =>
  ({ name: 'agent', model: 'claude-opus-5-5', systemPrompt: 'You are an agent.', ...settings }) as AgentConfig;
const systemNote = (text: string): ContextInjection => ({ namespace: 'note', position: 'system', content: [{ type: 'text', text }] }) as ContextInjection;

/** The options a framework turn's compile is given, for an agent with these settings, tools and injections. */
async function turnOptions(settings: Partial<AgentConfig>, tools: ToolDefinition[] = [], injections?: ContextInjection[]): Promise<Opts> {
  const { contextManager, seen } = recording();
  const agent = new Agent(config(settings), contextManager, new MockMembrane().asMembrane());
  await agent.startStreamWithInjections(tools, injections);
  agent.cancelStream();
  assert.equal(seen.length, 1);
  return seen[0];
}

describe('thinkingBinding.binds', () => {
  it('tells each compile a framework turn sends the binding and the request head\'s digests, and tells nothing without it', async () => {
    const binding = await turnOptions({ thinkingBinding: { binds: true, dropBlock: true } }, [tool('a')]);
    assert.deepEqual(binding?.thinkingBinding, { binds: true, dropBlock: true, participant: 'agent' }, 'the agent\'s own name, which its replies are stored under');
    assert.deepEqual(Object.keys(binding?.identity ?? {}).sort(), ['model', 'request', 'system', 'tools']);
    for (const digest of Object.values(binding!.identity!)) assert.match(digest, /^[0-9a-f]{64}$/);
    assert.deepEqual((await turnOptions({ thinkingBinding: { binds: true } }))?.thinkingBinding, { binds: true, dropBlock: false, participant: 'agent' });
    for (const settings of [{}, { thinkingBinding: { dropBlock: true } }, { thinkingBinding: { binds: false } }]) {
      const opts = await turnOptions(settings);
      assert.equal(opts?.thinkingBinding, undefined, JSON.stringify(settings));
      assert.equal(opts?.identity, undefined, JSON.stringify(settings));
    }
  });

  it('changes the digest of the part of the head that changed, and no other', async () => {
    const base = { thinkingBinding: { binds: true } };
    const id = async (settings: Partial<AgentConfig>, tools: ToolDefinition[], injections?: ContextInjection[]) =>
      (await turnOptions({ ...base, ...settings }, tools, injections))!.identity!;
    const a = await id({}, [tool('a'), tool('b')], [systemNote('one')]);
    assert.deepEqual(await id({}, [tool('a'), tool('b')], [systemNote('one')]), a, 'the same head gives the same digests');
    const changed = (b: Record<string, string>) => Object.keys(a).filter((k) => a[k as keyof typeof a] !== b[k]);
    assert.deepEqual(changed(await id({}, [tool('b'), tool('a')], [systemNote('one')])), ['tools'], 'the tools in another order');
    assert.deepEqual(changed(await id({}, [tool('a'), tool('b')], [systemNote('two')])), ['system'], 'a system-position injection');
    assert.deepEqual(changed(await id({ systemPrompt: 'You are another agent.' }, [tool('a'), tool('b')], [systemNote('one')])), ['system'], 'the system prompt');
    assert.deepEqual(changed(await id({ model: 'claude-sonnet-5-5' }, [tool('a'), tool('b')], [systemNote('one')])), ['model'], 'the model');
    for (const settings of [{ maxTokens: 999 }, { thinking: { enabled: true, budgetTokens: 2048 } }, { providerParams: { tool_choice: { type: 'any' } } }, { thinkingBinding: { binds: true, dropBlock: true } }] as Array<Partial<AgentConfig>>) {
      assert.deepEqual(changed(await id(settings, [tool('a'), tool('b')], [systemNote('one')])), ['request'], JSON.stringify(settings));
    }
  });

  it('tells the direct API\'s compile the same, from the same head', async () => {
    const { contextManager, seen } = recording();
    const membrane = { stream: async (_request: NormalizedRequest) => createMockResponse([{ type: 'text', text: 'ok' }]) } as unknown as Membrane;
    const agent = new Agent(config({ thinkingBinding: { binds: true } }), contextManager, membrane);
    await agent.runInferenceWithInjections([tool('a')], [systemNote('one')]);
    assert.deepEqual(seen[0], await turnOptions({ thinkingBinding: { binds: true } }, [tool('a')], [systemNote('one')]));
  });

  it('tells the framework\'s preview, a dry compile, the same', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-binds-preview-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: new MockMembrane().asMembrane(),
      agents: [config({ thinkingBinding: { binds: true } })], modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    try {
      const cm = framework.getAgent('agent')!.getContextManager();
      const seen: Opts[] = [];
      const compile = cm.compile.bind(cm);
      cm.compile = ((budget, injections, opts) => { seen.push(opts as Opts); return compile(budget, injections, opts); }) as typeof compile;
      await framework.previewActivation('agent');
      assert.equal(seen.length, 1);
      assert.equal((seen[0] as { dryRun?: boolean }).dryRun, true, 'a dry run');
      assert.deepEqual(seen[0]?.thinkingBinding, { binds: true, dropBlock: false, participant: 'agent' });
      assert.deepEqual(Object.keys(seen[0]?.identity ?? {}).sort(), ['model', 'request', 'system', 'tools']);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a binds that is not true or false', () => {
    for (const binds of ['true', 1, {}]) {
      assert.throws(() => new Agent(config({ thinkingBinding: { binds } as never }), recording().contextManager, {} as Membrane),
        /thinkingBinding\.binds/, JSON.stringify(binds));
    }
    for (const binds of [true, false, undefined, null]) {
      assert.doesNotThrow(() => new Agent(config({ thinkingBinding: { binds } as never }), recording().contextManager, {} as Membrane), String(binds));
    }
  });
});
