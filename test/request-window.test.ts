import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { defaultTokenEstimator } from '@animalabs/context-manager';
import type { EventResponse, Module, ProcessEvent, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

const WINDOW = 8_000;
const REPLY = 1_000;
const SYSTEM = `You are prime. ${'Keep to the facts. '.repeat(30)}`;

/** Tools whose definitions the request carries beside the window: about 2,000 tokens of them. */
class ToolsModule implements Module {
  readonly name = 'tools';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return Array.from({ length: 6 }, (_, i) => ({
      name: `act_${i}`,
      description: 'Does one thing in the channel it names, and says what it did. '.repeat(16),
      inputSchema: { type: 'object', properties: { channel: { type: 'string' } } },
    }));
  }
  async handleToolCall(): Promise<ToolResult> {
    return { success: true, data: 'done' };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }], requestInference: true };
  }
}

const textOf = (block: ContentBlock) => (block.type === 'text' ? (block as { text: string }).text : JSON.stringify(block));

/** The request as context-manager's estimator prices it: system, messages, tools and the reply's max_tokens. */
function requestTokens(request: NormalizedRequest): number {
  const system = typeof request.system === 'string' ? defaultTokenEstimator(request.system) : 0;
  const messages = request.messages.reduce((n, m) => n + m.content.reduce((k, b) => k + defaultTokenEstimator(textOf(b)), 0), 0);
  const tools = request.tools && request.tools.length > 0 ? defaultTokenEstimator(JSON.stringify(request.tools)) : 0;
  return system + messages + tools + (request.config?.maxTokens ?? 0);
}

type Compiled = { budget: unknown; opts: Record<string, unknown> | undefined };

async function open(physicalWindowTokens: number | undefined, config: { maxTokens?: number; contextBudgetTokens?: number | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'request-window-'));
  const membrane = new MockMembrane();
  for (let i = 0; i < 4; i++) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Noted.' }]));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'prime',
      model: 'test-model',
      systemPrompt: SYSTEM,
      allowedTools: 'all',
      maxTokens: config.maxTokens ?? REPLY,
      ...(config.contextBudgetTokens === null ? {} : { contextBudgetTokens: config.contextBudgetTokens ?? 100_000 }),
      ...(physicalWindowTokens !== undefined ? { physicalWindowTokens } : {}),
    }],
    modules: [new ToolsModule()],
    syncIntervalMs: 0,
  });
  const agent = framework.getAgent('prime')!;
  const cm = agent.getContextManager();
  for (let i = 0; i < 40; i++) {
    cm.addMessage(i % 2 ? 'prime' : 'User', [{ type: 'text', text: `Message ${i}: the river runs past the mill and the heron waits by the reeds. `.repeat(8) }]);
  }
  const compiled: Compiled[] = [];
  const original = cm.compile.bind(cm);
  cm.compile = ((budget: unknown, injections: unknown, opts: Record<string, unknown> | undefined) => {
    compiled.push({ budget, opts });
    return (original as (...a: unknown[]) => ReturnType<typeof cm.compile>)(budget, injections, opts);
  }) as typeof cm.compile;
  const close = async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { framework, agent, membrane, compiled, close };
}

async function turn(framework: AgentFramework, membrane: MockMembrane): Promise<NormalizedRequest> {
  framework.start();
  framework.pushEvent({
    type: 'external-message', source: 'test', content: [{ type: 'text', text: 'What happened at the mill?' }], metadata: {}, triggerInference: true,
  } as unknown as ProcessEvent);
  for (let i = 0; i < 400 && membrane.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(membrane.calls.length > 0, 'premise: the turn sent a request');
  return membrane.calls[0]!;
}

describe('a request bounded by the model\'s window (physicalWindowTokens)', () => {
  it('the first request of a turn is within the window, its system prompt and tools counted', async () => {
    const t = await open(WINDOW);
    try {
      const request = await turn(t.framework, t.membrane);
      assert.ok(requestTokens(request) <= WINDOW, `the turn's first request is ${requestTokens(request)} tokens, the window ${WINDOW}`);
    } finally {
      await t.close();
    }
  });

  it('with no budget set, the reply\'s whole maxTokens is kept out of the window, not context-manager\'s default reserve', async () => {
    const window = 12_000;
    const t = await open(window, { maxTokens: 6_000, contextBudgetTokens: null });
    try {
      const request = await turn(t.framework, t.membrane);
      assert.equal(request.config?.maxTokens, 6_000, 'premise: the request asks for 6,000, more than context-manager\'s default reserve of 4,000');
      assert.ok(requestTokens(request) <= window, `the turn's first request is ${requestTokens(request)} tokens, the window ${window}`);
    } finally {
      await t.close();
    }
  });

  it('a stream\'s compile is given the request\'s overhead as sent and the window', async () => {
    const t = await open(WINDOW);
    try {
      const request = await turn(t.framework, t.membrane);
      const sent = t.compiled.find((c) => c.opts?.dryRun !== true)!;
      assert.deepStrictEqual(sent.opts?.requestOverhead, { system: request.system, tools: request.tools });
      assert.equal(sent.opts?.requestLimitTokens, WINDOW);
    } finally {
      await t.close();
    }
  });

  it('the direct API\'s compile is bounded the same way', async () => {
    const t = await open(WINDOW);
    try {
      await t.agent.runInference(t.framework.getAllTools());
      const request = t.membrane.calls[0]!;
      assert.ok(requestTokens(request) <= WINDOW, `the direct API's request is ${requestTokens(request)} tokens, the window ${WINDOW}`);
      const sent = t.compiled[t.compiled.length - 1]!;
      assert.deepStrictEqual(sent.opts?.requestOverhead, { system: request.system, tools: request.tools });
      assert.equal(sent.opts?.requestLimitTokens, WINDOW);
    } finally {
      await t.close();
    }
  });

  it('a preview\'s dry compile is given what the live one is', async () => {
    const t = await open(WINDOW);
    try {
      const preview = await t.framework.previewActivation('prime');
      const dry = t.compiled.find((c) => c.opts?.dryRun === true)!;
      assert.ok(dry, 'premise: the preview compiled dry');
      assert.deepStrictEqual(dry.opts?.requestOverhead, { system: (preview as NormalizedRequest).system, tools: (preview as NormalizedRequest).tools });
      assert.equal(dry.opts?.requestLimitTokens, WINDOW);
    } finally {
      await t.close();
    }
  });

  it('without a window, the compile is given the overhead and no limit', async () => {
    const t = await open(undefined);
    try {
      const request = await turn(t.framework, t.membrane);
      const sent = t.compiled.find((c) => c.opts?.dryRun !== true)!;
      assert.deepStrictEqual(sent.opts?.requestOverhead, { system: request.system, tools: request.tools });
      assert.ok(!('requestLimitTokens' in (sent.opts ?? {})), 'no limit');
    } finally {
      await t.close();
    }
  });

  it('a window the system prompt and tools fill by themselves sends nothing', async () => {
    const t = await open(REPLY + 500);
    try {
      t.framework.start();
      t.framework.pushEvent({
        type: 'external-message', source: 'test', content: [{ type: 'text', text: 'Anything?' }], metadata: {}, triggerInference: true,
      } as unknown as ProcessEvent);
      for (let i = 0; i < 100; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(t.membrane.calls.length, 0, 'no request went to the provider');
    } finally {
      await t.close();
    }
  });
});
