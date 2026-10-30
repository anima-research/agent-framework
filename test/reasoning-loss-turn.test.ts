import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextManager } from '@animalabs/context-manager';
import { MembraneError } from '@animalabs/membrane';
import type { DetailedUsage, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';

import { AgentFramework } from '../src/index.js';
import type { Agent, Module, ToolCall } from '../src/index.js';
import { forkAgentName } from '../src/mcpl/conversation-router.js';
import { branchKey } from '../src/agent.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

class EchoTools implements Module {
  readonly name = 'test';
  async start() {}
  async stop() {}
  async onProcess() { return {}; }
  getTools() {
    return [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' as const, properties: {} } }];
  }
  async handleToolCall(_call: ToolCall) {
    return { success: true, data: {} };
  }
}

type Entry = { reason: string; path: string; message?: number; round?: number };
const usage: DetailedUsage = { inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 };
function withDrops(response: NormalizedResponse, dropped?: Entry[]): NormalizedResponse {
  return Object.assign(response, dropped ? { usage, round: { thinking: { dropped, mismatchAllowed: [] } } } : { usage });
}
const toolCall = (id: string) => createMockResponse([{ type: 'tool_use', id, name: 'test--echo', input: {} }], 'tool_use');

function lines(cm: ContextManager): Array<{ text: string; kind?: string; system?: boolean }> {
  return (cm.getAllMessages() as unknown as Array<{ content: Array<{ type: string; text?: string }>; metadata?: { kind?: string; system?: boolean } }>)
    .flatMap((m) => m.content.filter((b) => b.type === 'text' && b.text?.startsWith('[reasoning]'))
      .map((b) => ({ text: b.text!, ...(m.metadata?.kind ? { kind: m.metadata.kind } : {}), ...(m.metadata?.system ? { system: true } : {}) })));
}

type StripFor = unknown | ((cm: ContextManager) => unknown) | undefined;

function reportStrips(cm: ContextManager, strips: StripFor[]): void {
  const compile = cm.compile.bind(cm);
  let n = 0;
  (cm as unknown as { compile: typeof compile }).compile = (async (...args: Parameters<typeof compile>) => {
    const result = await compile(...args);
    const given = strips[n++];
    const strip = typeof given === 'function' ? (given as (cm: ContextManager) => unknown)(cm) : given;
    return strip === undefined ? result : { ...result, thinkingStrip: strip };
  }) as typeof compile;
}

class FailsAfterItsTools extends MockYieldingStream {
  constructor(responses: NormalizedResponse[], private readonly error: Error) {
    super(responses);
  }
  override provideToolResults(results: unknown[], options?: { injectedMessages?: Array<{ participant?: string; content: unknown[] }> }): void {
    this.receivedToolResults.push(results);
    this.receivedToolResultOptions.push(options);
    const self = this as unknown as {
      events: StreamEvent[]; _isWaitingForTools: boolean; _pendingToolCallIds: string[]; _done: boolean; pendingResolve: (() => void) | null;
    };
    self._isWaitingForTools = false;
    self._pendingToolCallIds = [];
    self.events.push({ type: 'error', error: this.error } as StreamEvent);
    self._done = true;
    const resolve = self.pendingResolve;
    self.pendingResolve = null;
    resolve?.();
  }
}

class RetriedAfterATool extends MockMembrane {
  private n = 0;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    if (++this.n === 1) {
      return new FailsAfterItsTools([toolCall('c1')], new MembraneError({
        type: 'server', retryable: true, httpStatus: 500, message: 'Internal server error',
        rawError: { status: 500 }, rawRequest: request,
      }));
    }
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'Done.' }])]);
  }
}

async function run(
  responses: NormalizedResponse[],
  strips: StripFor[] = [],
  membrane: MockMembrane = new MockMembrane(),
  options: {
    resident?: boolean;
    beforeRun?: (framework: AgentFramework, agent: Agent) => Promise<void>;
    afterRun?: (framework: AgentFramework, agent: Agent) => Promise<void>;
  } = {},
): Promise<{ said: Array<{ text: string; kind?: string; system?: boolean }>; order: string[]; resident: string[]; injected: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'af-reasoning-loss-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: options.resident ? [{ name: 'resident', model: 'test-model', systemPrompt: 'Wait.' }] : [],
    modules: [new EchoTools()], syncIntervalMs: 0,
    errorPolicy: { maxRetries: 1, onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt === 0 ? { retry: true, delayMs: 5 } : { retry: false }) },
  });
  framework.start();
  try {
    for (const response of responses) membrane.pushResponse(response);
    const { agent, contextManager } = await framework.createEphemeralAgent({
      name: 'worker', model: 'claude-opus-5-5', systemPrompt: 'Do the task.', allowedTools: 'all',
      proseRouting: 'disabled', thinkingBinding: { dropBlock: true },
    });
    reportStrips(contextManager, strips);
    contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
    await options.beforeRun?.(framework, agent);
    await framework.runEphemeralToCompletion(agent, contextManager);
    await options.afterRun?.(framework, agent);
    const order = (contextManager.getAllMessages() as unknown as Array<{ participant: string; content: Array<{ type: string; text?: string }> }>)
      .map((m) => `${m.participant}:${m.content.map((b) => (b.type === 'text' ? (b.text!.startsWith('[reasoning]') ? 'line' : 'text') : b.type)).join('+')}`);
    const residentCm = options.resident ? framework.getAgent('resident')!.getContextManager() : undefined;
    const injected = (membrane.lastStream?.receivedToolResultOptions ?? [])
      .flatMap((o) => o?.injectedMessages ?? [])
      .flatMap((m) => (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text' && b.text?.startsWith('[reasoning]')).map((b) => b.text!));
    return {
      said: lines(contextManager),
      order,
      resident: residentCm ? lines(residentCm).map((l) => l.text) : [],
      injected,
    };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('no line about lost reasoning reaches an agent', () => {
  it('a strip at a change of the request\'s head puts nothing in its context or in the stream', async () => {
    const { said, order, injected } = await run(
      [toolCall('c1'), createMockResponse([{ type: 'text', text: 'Done.' }])],
      [{ newly: ['m-earlier'], cause: 'head', changed: ['tools'] }],
    );
    assert.ok(order.some((o) => o.includes('tool_use')), `premise: the turn ran: ${order.join(' | ')}`);
    assert.deepEqual(said, []);
    assert.deepEqual(injected, []);
    assert.ok(!order.includes('user:line'), order.join(' | '));
  });

  it('a block the provider drops, on every later call too, puts nothing in its context', async () => {
    const round0 = { reason: 'prefix_binding_mismatch', path: 'messages.2.content.0', round: 0 };
    const { said, order } = await run([
      toolCall('c1'),
      withDrops(toolCall('c2'), [round0]),
      withDrops(toolCall('c3'), [round0]),
      withDrops(createMockResponse([{ type: 'text', text: 'Done.' }]), [round0]),
    ]);
    assert.ok(order.includes('worker:text'), `premise: the last call ran: ${order.join(' | ')}`);
    assert.deepEqual(said, []);
  });

  it('a fold forced mid-turn that takes this turn\'s own step puts nothing in its context', async () => {
    const thisTurnsReply = (cm: ContextManager) => {
      const replies = (cm.getAllMessages() as unknown as Array<{ id: string; participant: string }>).filter((m) => m.participant === 'worker');
      return { newly: replies.map((m) => m.id), cause: 'messages' };
    };
    const { said, order } = await run([], [undefined, thisTurnsReply], new RetriedAfterATool());
    assert.ok(order.some((o) => o.startsWith('worker:') && o.includes('tool_use')), `premise: the first stream stored its reply: ${order.join(' | ')}`);
    assert.deepEqual(said, []);
  });

  it('a resident beside the run is told nothing either', async () => {
    const { resident } = await run(
      [createMockResponse([{ type: 'text', text: 'Done.' }])],
      [{ newly: ['m-earlier'], cause: 'head', changed: ['system'] }],
      new MockMembrane(),
      { resident: true },
    );
    assert.deepEqual(resident, []);
  });

  it('leaves a host\'s own strip observer in place, and the agent is told nothing', async () => {
    const heard: unknown[] = [];
    const { said } = await run(
      [createMockResponse([{ type: 'text', text: 'Done.' }])],
      [{ newly: ['m-earlier'], cause: 'head', changed: ['tools'] }],
      new MockMembrane(),
      { beforeRun: async (_framework, agent) => { agent.onThinkingStrip = (strip) => { heard.push(strip); }; } },
    );
    assert.equal(heard.length, 1);
    assert.deepEqual(said, []);
  });
});

describe('Agent.onThinkingStrip', () => {
  it('is called with each committing compile\'s strip and the branch it read, never with a dry compile\'s, and can\'t fail the compile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-reasoning-loss-hook-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: new MockMembrane().asMembrane(), agents: [], modules: [], syncIntervalMs: 0,
    });
    try {
      const { agent, contextManager } = await framework.createEphemeralAgent({
        name: 'worker', model: 'claude-opus-5-5', systemPrompt: 'Do the task.', allowedTools: 'all',
        proseRouting: 'disabled', thinkingBinding: { dropBlock: true },
      });
      const strip = { newly: ['m-earlier'], cause: 'head', changed: ['system'] };
      reportStrips(contextManager, [strip, strip, strip, strip]);
      contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      const heard: string[] = [];
      agent.onThinkingStrip = (given, branch) => {
        assert.deepEqual(given, strip);
        heard.push(branch);
      };
      const main = branchKey(contextManager.currentBranchRef());
      await agent.compileWithInjections();
      await agent.compileWithInjections(undefined, undefined, { dryRun: true });
      await contextManager.fork('side');
      const side = branchKey(contextManager.currentBranchRef());
      await agent.compileWithInjections();
      assert.notEqual(main, side);
      assert.deepEqual(heard, [main, side]);
      let threw = false;
      agent.onThinkingStrip = () => { threw = true; throw new Error('observer failed'); };
      const errors: string[] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
      const result = await agent.compileWithInjections().finally(() => { console.error = consoleError; });
      assert.ok(threw, 'premise: the hook was called and threw');
      assert.ok(errors.includes("[agent] worker: the host's thinking-strip observer failed:"), errors.join('\n'));
      assert.equal(result.thinkingStrip, strip, 'a hook that throws leaves the compile its result');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
