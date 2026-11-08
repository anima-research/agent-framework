import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { defaultTokenEstimator, jsonTokenEstimator } from '@animalabs/context-manager';
import type { EventResponse, Module, ProcessEvent, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';
import { CONTINUE_ROW, SILENT_HEARTBEAT_SEPARATOR } from '../src/silent-heartbeat.js';
import { isDeepStrictEqual } from 'node:util';

const WINDOW = 8_000;
/** A tool result of about 1,000 tokens at context-manager's rate for tool text. */
const RESULT_DATA = `{"rows":[${'{"id":"r","value":"a row of output"},'.repeat(50)}{}]}`;
/** The trailing turn a stream start may end on, which context-manager is given to price. */
const CONTINUE: ContentBlock[] = [{ type: 'text', text: CONTINUE_ROW }];
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

/** A block as context-manager's estimator prices it: a tool result's text at the dense rate, anything else by its text or JSON. */
const blockTokens = (block: ContentBlock) => {
  if (block.type === 'text') return defaultTokenEstimator((block as { text: string }).text);
  const content = (block as { content?: unknown }).content;
  if (block.type === 'tool_result' && typeof content === 'string') return jsonTokenEstimator(content);
  if (block.type === 'tool_use') return jsonTokenEstimator(JSON.stringify((block as { input?: unknown }).input)) + 20;
  return defaultTokenEstimator(JSON.stringify(block));
};

/** The request as context-manager's estimator prices it: system, messages, tools and the reply's max_tokens. */
function requestTokens(request: NormalizedRequest): number {
  const system = typeof request.system === 'string' ? defaultTokenEstimator(request.system) : 0;
  const messages = request.messages.reduce((n, m) => n + m.content.reduce((k, b) => k + blockTokens(b), 0), 0);
  const tools = request.tools && request.tools.length > 0 ? defaultTokenEstimator(JSON.stringify(request.tools)) : 0;
  return system + messages + tools + (request.config?.maxTokens ?? 0);
}

type Compiled = { budget: unknown; opts: Record<string, unknown> | undefined };

type Config = {
  maxTokens?: number;
  contextBudgetTokens?: number | null;
  toolResultGuard?: boolean;
  prefillUserMessage?: string;
  /** The first reply calls a tool, for the direct API's tool round. */
  callsTool?: boolean;
};

async function open(physicalWindowTokens: number | undefined, config: Config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'request-window-'));
  const membrane = new MockMembrane();
  if (config.callsTool) membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'tu1', name: 'act_0', input: { channel: 'mill' } } as never], 'tool_use'));
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
      ...(config.toolResultGuard ? { toolResultGuard: true } : {}),
      ...(config.prefillUserMessage !== undefined ? { prefillUserMessage: config.prefillUserMessage } : {}),
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

  it('a stream\'s compile is given the request\'s system prompt and tools as sent, the trailing turn it may end on, and the window', async () => {
    const t = await open(WINDOW);
    try {
      const request = await turn(t.framework, t.membrane);
      const sent = t.compiled.find((c) => c.opts?.dryRun !== true)!;
      assert.deepStrictEqual(sent.opts?.requestOverhead, { system: request.system, tools: request.tools, messages: [CONTINUE] });
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
      assert.deepStrictEqual(dry.opts?.requestOverhead, { system: (preview as NormalizedRequest).system, tools: (preview as NormalizedRequest).tools, messages: [CONTINUE] });
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

  for (const guard of [false, true]) {
    it(`the direct API prices a pending tool result beside the window, as the request sends it, and keeps the request within the window (guard ${guard ? 'on' : 'off'})`, async () => {
      const t = await open(WINDOW, { callsTool: true, toolResultGuard: guard });
      try {
        const tools = t.framework.getAllTools();
        const first = await t.agent.runInference(tools);
        assert.equal(first.toolCalls.length, 1, 'premise: one tool call');
        t.agent.provideToolResult('tu1' as never, { success: true, data: RESULT_DATA } as never);
        await t.agent.runInference(tools);
        const request = t.membrane.calls[t.membrane.calls.length - 1]!;
        const result = request.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && (b as { toolUseId: string }).toolUseId === 'tu1');
        assert.ok(result && blockTokens(result) > 800, `premise: the request carries the result, ${result ? blockTokens(result) : 0} tokens`);
        assert.ok(requestTokens(request) <= WINDOW, `the request after the result is ${requestTokens(request)} tokens, the window ${WINDOW}`);
        const sent = t.compiled[t.compiled.length - 1]!;
        const beside = (sent.opts?.requestOverhead as { messages?: ContentBlock[][] } | undefined)?.messages ?? [];
        assert.ok(beside.some((m) => m.some((b) => isDeepStrictEqual(b, result))), 'the compile was given the result as the request sends it');
        assert.equal((sent.budget as { reserveForResponse: number }).reserveForResponse, REPLY, 'only the reply is reserved');
        const unused = WINDOW - requestTokens(request);
        assert.ok(unused < Math.ceil(RESULT_DATA.length / 4), `the batch counts once against the window: ${unused} tokens of it unused`);
      } finally {
        await t.close();
      }
    });
  }

  it('with a window that doesn\'t bind, the guard\'s pending results take the room they take without one, and the compile selects the same', async () => {
    const select = async (window: number | undefined) => {
      const t = await open(window, { callsTool: true, toolResultGuard: true, contextBudgetTokens: 5_000 });
      try {
        const tools = t.framework.getAllTools();
        await t.agent.runInference(tools);
        t.agent.provideToolResult('tu1' as never, { success: true, data: RESULT_DATA } as never);
        await t.agent.runInference(tools);
        const budget = t.compiled[t.compiled.length - 1]!.budget as { maxTokens: number; reserveForResponse: number };
        const request = t.membrane.calls[t.membrane.calls.length - 1]!;
        return { room: budget.maxTokens - budget.reserveForResponse, reply: budget.reserveForResponse, request };
      } finally {
        await t.close();
      }
    };
    const without = await select(undefined);
    const within = await select(100_000);
    assert.ok(!JSON.stringify(without.request.messages).includes('Message 0:'), 'premise: the budget binds');
    assert.ok(requestTokens(within.request) < 100_000 / 2, 'premise: the window doesn\'t');
    assert.equal(within.room, without.room, 'the same room as without a window');
    assert.equal(within.reply, REPLY, 'the reply alone is reserved within the window');
    assert.deepStrictEqual(within.request.messages, without.request.messages, 'the same request');
  });

  it('without a window, the guard\'s pending results keep their reserve and nothing is priced beside the window', async () => {
    const t = await open(undefined, { callsTool: true, toolResultGuard: true });
    try {
      const tools = t.framework.getAllTools();
      await t.agent.runInference(tools);
      t.agent.provideToolResult('tu1' as never, { success: true, data: RESULT_DATA } as never);
      await t.agent.runInference(tools);
      const sent = t.compiled[t.compiled.length - 1]!;
      const request = t.membrane.calls[t.membrane.calls.length - 1]!;
      assert.deepStrictEqual(sent.opts?.requestOverhead, { system: request.system, tools: request.tools });
      assert.ok((sent.budget as { reserveForResponse: number }).reserveForResponse > REPLY, 'the guard\'s reserve is added to the reply\'s');
    } finally {
      await t.close();
    }
  });

  it('a prefill message the request may send is priced beside the window', async () => {
    const prefill = 'The conversation so far, as the house keeps it.';
    const t = await open(WINDOW, { prefillUserMessage: prefill });
    try {
      await turn(t.framework, t.membrane);
      const sent = t.compiled.find((c) => c.opts?.dryRun !== true)!;
      const beside = (sent.opts?.requestOverhead as { messages?: ContentBlock[][] }).messages ?? [];
      assert.ok(beside.some((m) => isDeepStrictEqual(m, [{ type: 'text', text: prefill }])), JSON.stringify(beside));
    } finally {
      await t.close();
    }
  });

  it('a silent tick\'s start prices its separator, not [Continue], as the trailing turn', async () => {
    const t = await open(WINDOW);
    try {
      const tools = t.framework.getAllTools();
      await t.agent.buildActivationRequest(tools, undefined, undefined, tools, { dryRun: true, silentHeartbeat: { eventId: 'tick-1', serverId: 'clock' } });
      const dry = t.compiled[t.compiled.length - 1]!;
      const beside = (dry.opts?.requestOverhead as { messages?: ContentBlock[][] }).messages ?? [];
      assert.deepStrictEqual(beside, [[{ type: 'text', text: SILENT_HEARTBEAT_SEPARATOR }]]);
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
