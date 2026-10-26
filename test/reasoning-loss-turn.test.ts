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
import type { ReasoningLossTeller } from '../src/reasoning-loss.js';
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

type Teller = { told: Map<string, unknown>; drops: { alerted: Map<string, unknown> } };

async function run(
  responses: NormalizedResponse[],
  strips: StripFor[] = [],
  membrane: MockMembrane = new MockMembrane(),
  options: {
    resident?: boolean;
    beforeRun?: (framework: AgentFramework, agent: Agent) => Promise<void>;
    afterRun?: (framework: AgentFramework, agent: Agent) => Promise<void>;
  } = {},
): Promise<{ said: Array<{ text: string; kind?: string; system?: boolean }>; order: string[]; remembered: boolean; resident: string[]; injected: string[] }> {
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
    const teller = (framework as unknown as { reasoningLoss: Teller }).reasoningLoss;
    const residentCm = options.resident ? framework.getAgent('resident')!.getContextManager() : undefined;
    const injected = (membrane.lastStream?.receivedToolResultOptions ?? [])
      .flatMap((o) => o?.injectedMessages ?? [])
      .flatMap((m) => (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text' && b.text?.startsWith('[reasoning]')).map((b) => b.text!));
    return {
      said: lines(contextManager),
      order,
      remembered: teller.told.has('worker') || teller.drops.alerted.has('worker'),
      resident: residentCm ? lines(residentCm).map((l) => l.text) : [],
      injected,
    };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the resident\'s line for lost reasoning, on a turn', () => {
  it('tells a strip at a change of the request\'s head once, with its cause, after the change', async () => {
    const { said, order, injected } = await run(
      [toolCall('c1'), createMockResponse([{ type: 'text', text: 'Done.' }])],
      [{ newly: ['m-earlier'], cause: 'head', changed: ['tools'] }],
    );
    const text = '[reasoning] worker: The reasoning behind your earlier replies is no longer in your context, because your tools changed. ' +
      'Their words are still here. Re-read before relying on an earlier decision.';
    assert.deepEqual(said, [{ text, kind: 'reasoning-loss', system: true }]);
    const at = order.indexOf('user:line');
    const reply = order.findIndex((o) => o.includes('tool_use'));
    assert.ok(reply >= 0, `premise: the first reply is stored: ${order.join(' | ')}`);
    assert.ok(at > reply, `after the first reply: ${order.join(' | ')}`);
    assert.deepEqual(injected, [text], 'the framework passes it to the stream with the tool round\'s results');
  });

  it('tells nothing of a fold between turns, or of a compile that reports no strip', async () => {
    let folded: string[] = [];
    const { said } = await run(
      [toolCall('c1'), createMockResponse([{ type: 'text', text: 'Done.' }])],
      [(cm: ContextManager) => {
        folded = (cm.getAllMessages() as unknown as Array<{ id: string; participant: string }>).filter((m) => m.participant === 'worker').map((m) => m.id);
        return { newly: folded, cause: 'messages' };
      }],
      new MockMembrane(),
      { beforeRun: async (_framework, agent) => { agent.getContextManager().addMessage('worker', [{ type: 'text', text: 'An earlier reply.' }]); } },
    );
    assert.equal(folded.length, 1, 'premise: the fold takes a reply stored before the turn');
    assert.deepEqual(said, []);
    assert.deepEqual((await run([createMockResponse([{ type: 'text', text: 'Done.' }])])).said, []);
  });

  it('tells a block of this stream\'s own round once, though every later call drops it again', async () => {
    const round0 = { reason: 'prefix_binding_mismatch', path: 'messages.2.content.0', round: 0 };
    const { said, order } = await run([
      toolCall('c1'),
      withDrops(toolCall('c2'), [round0]),
      withDrops(toolCall('c3'), [round0]),
      withDrops(createMockResponse([{ type: 'text', text: 'Done.' }]), [round0]),
    ]);
    assert.equal(order.filter((o) => o.startsWith('worker:') && o.includes('tool_use')).length, 3, `premise: every call ran: ${order.join(' | ')}`);
    assert.ok(order.includes('worker:text'), `premise: the last call ran: ${order.join(' | ')}`);
    assert.deepEqual(said.map((s) => s.text), [
      '[reasoning] worker: Some of your earlier reasoning is no longer in your context: the reasoning behind one of your replies, ' +
        'an earlier step of this turn. Their words are still here. Re-read before relying on an earlier decision.',
    ]);
  });

  it('tells a fold forced mid-turn that takes this turn\'s own step, naming it by its tool call', async () => {
    const thisTurnsReply = (cm: ContextManager) => {
      const replies = (cm.getAllMessages() as unknown as Array<{ id: string; participant: string }>).filter((m) => m.participant === 'worker');
      return { newly: replies.map((m) => m.id), cause: 'messages' };
    };
    const { said, order } = await run([], [undefined, thisTurnsReply], new RetriedAfterATool());
    assert.ok(order.some((o) => o.startsWith('worker:') && o.includes('tool_use')), `the first stream stored its reply: ${order.join(' | ')}`);
    assert.deepEqual(said.map((s) => s.text), [
      '[reasoning] worker: Some of your earlier reasoning is no longer in your context: the reasoning behind one of your replies, ' +
        'the one that called `test--echo`, an earlier step of this turn. Their words are still here. Re-read before relying on a decision made since then.',
    ]);
  });

  it('keeps nothing of an ephemeral run\'s told strips and incidents once the run ends', async () => {
    const dropped = { reason: 'prefix_binding_mismatch', path: 'messages.2.content.0', round: 0 };
    const { said, remembered } = await run(
      [toolCall('c1'), withDrops(toolCall('c2'), [dropped]), withDrops(createMockResponse([{ type: 'text', text: 'Done.' }]), [dropped])],
      [{ newly: ['m-earlier'], cause: 'head', changed: ['tools'] }],
    );
    assert.equal(said.length, 2, 'premise: a strip and an incident were told, the incident still open at the run\'s last call');
    assert.equal(remembered, false);
  });

  it('tells the strip of a compile whose result is thrown away because an annotation began during it', async () => {
    let guard: { annotationsStarted: number } | undefined;
    let compiles = 0;
    const { said } = await run(
      [createMockResponse([{ type: 'text', text: 'Done.' }])],
      [() => {
        compiles++;
        guard!.annotationsStarted++;
        return { newly: ['m-earlier'], cause: 'head', changed: ['system'] };
      }, () => { compiles++; return undefined; }],
      new MockMembrane(),
      { beforeRun: async (_framework, agent) => { guard = agent.toolResultGuard as unknown as { annotationsStarted: number }; } },
    );
    assert.equal(compiles, 2, 'premise: the first compile was run again');
    assert.match(said.map((s) => s.text).join('\n'), /because your system prompt changed\./);
  });

  it('keeps nothing of a conversation fork\'s told strips and incidents once it ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-reasoning-loss-fork-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' }],
      modules: [], conversations: { templateAgent: 'trunk' },
    });
    const internals = framework as unknown as {
      createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<unknown>;
      disposeConversationAgent(name: string): void;
      reasoningLoss: ReasoningLossTeller;
    };
    const name = forkAgentName('conversation', 'srv', 'slack:D9', 1);
    const reader = { getMessage: () => null };
    const state = () => internals.reasoningLoss as unknown as Teller;
    try {
      await internals.createConversationAgent(name, { serverId: 'srv', channelId: 'slack:D9' });
      internals.reasoningLoss.forStrip(name, 'main', { newly: ['m-earlier'], cause: 'head', changed: ['tools'] } as never, {}, reader);
      internals.reasoningLoss.forDrops(name, 'main', [{ kind: 'round', round: 0, entry: { reason: 'prefix_binding_mismatch', path: 'p' } }], {}, reader);
      assert.ok(state().told.has(name) && state().drops.alerted.has(name), 'premise: the fork was told of both');
      internals.disposeConversationAgent(name);
      assert.equal(state().told.has(name) || state().drops.alerted.has(name), false);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tells a new incident after a call that drops nothing', async () => {
    const round0 = { reason: 'prefix_binding_mismatch', path: 'messages.2.content.0', round: 0 };
    const { said } = await run([
      toolCall('c1'),
      withDrops(toolCall('c2'), [round0]),
      withDrops(toolCall('c3'), []),
      withDrops(createMockResponse([{ type: 'text', text: 'Done.' }]), [round0]),
    ]);
    assert.equal(said.length, 2);
  });

  it('tells a strip that the direct API\'s compile reports after a turn, calling none of the last turn\'s replies this turn\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-reasoning-loss-between-'));
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Again.' }]));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Wait.' }], modules: [], syncIntervalMs: 0,
    });
    framework.start();
    try {
      const agent = framework.getAgent('resident')!;
      const cm = agent.getContextManager();
      let taken: string[] = [];
      reportStrips(cm, [undefined, (c: ContextManager) => {
        taken = (c.getAllMessages() as unknown as Array<{ id: string; participant: string }>).filter((m) => m.participant === 'resident').map((m) => m.id);
        return { newly: taken, cause: 'head', changed: ['tools'] };
      }]);
      framework.nudgeAgent('resident', 'operator');
      const turns = (framework as unknown as { activeTurnTokens: Map<string, unknown> }).activeTurnTokens;
      for (let waited = 0; membrane.calls.length === 0 || agent.state.status !== 'idle' || turns.has('resident'); waited += 10) {
        if (waited > 3000) throw new Error('the turn did not end');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await agent.runInference([]);
      assert.equal(taken.length, 1, 'premise: the strip takes the last turn\'s reply');
      assert.deepEqual(lines(cm).map((l) => l.text), [
        '[reasoning] resident: The reasoning behind your replies up to the one beginning "Done." is no longer in your context, ' +
          'because your tools changed. Their words are still here. Re-read before relying on an earlier decision.',
      ]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('goes on when a strip\'s line can\'t be stored or made, saying so', async () => {
    let refused = 0;
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
    const { said, order } = await run(
      [toolCall('c1'), createMockResponse([{ type: 'text', text: 'Done.' }])],
      [{ newly: ['m-earlier'], cause: 'head', changed: ['tools'] }],
      new MockMembrane(),
      {
        beforeRun: async (framework) => {
          const internals = framework as unknown as { addMessage: (...args: unknown[]) => unknown };
          const addMessage = internals.addMessage.bind(framework);
          internals.addMessage = (...args: unknown[]) => {
            if ((args[1] as Array<{ text?: string }>)[0]?.text?.startsWith('[reasoning]')) {
              refused++;
              throw new Error('store refused');
            }
            return addMessage(...args);
          };
        },
      },
    ).finally(() => { console.error = consoleError; });
    assert.equal(refused, 1);
    assert.deepEqual(said, []);
    assert.ok(order.some((o) => o === 'worker:text'), `the turn went on to its reply: ${order.join(' | ')}`);
    assert.ok(errors.includes('[reasoning] worker: the line for lost reasoning could not be stored:'), errors.join('\n'));

    errors.length = 0;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
    const unread = await run(
      [createMockResponse([{ type: 'text', text: 'Done.' }])],
      [{ newly: ['m-earlier'], cause: 'head', changed: ['tools'] }],
      new MockMembrane(),
      {
        beforeRun: async (_framework, agent) => {
          const cm = agent.getContextManager();
          const getMessage = cm.getMessage.bind(cm);
          cm.getMessage = ((id: string) => {
            if (id === 'm-earlier') throw new Error('store unreadable');
            return getMessage(id as never);
          }) as typeof cm.getMessage;
        },
      },
    ).finally(() => { console.error = consoleError; });
    assert.deepEqual(unread.said, []);
    assert.ok(unread.order.some((o) => o === 'worker:text'), `the turn went on to its reply: ${unread.order.join(' | ')}`);
    assert.ok(errors.includes('[reasoning] worker: could not tell what reasoning was lost:'), errors.join('\n'));
  });

  it('tells nothing for an agent no longer registered, and keeps nothing for it', async () => {
    const { said, remembered } = await run(
      [createMockResponse([{ type: 'text', text: 'Done.' }])],
      [undefined, { newly: ['m-earlier'], cause: 'head', changed: ['tools'] }],
      new MockMembrane(),
      {
        afterRun: async (framework, agent) => {
          assert.equal(framework.getAgent('worker') ?? null, null, 'premise: the run\'s end removed its agent');
          await agent.compileWithInjections();
        },
      },
    );
    assert.deepEqual(said, []);
    assert.equal(remembered, false);
  });

  it('tells the run\'s own agent, not the primary', async () => {
    const { said, resident } = await run(
      [toolCall('c1'), createMockResponse([{ type: 'text', text: 'Done.' }])],
      [{ newly: ['m-earlier'], cause: 'head', changed: ['tools'] }],
      new MockMembrane(),
      { resident: true },
    );
    assert.equal(said.length, 1);
    assert.deepEqual(resident, []);
  });

  it('tells nothing of a call whose dropped blocks can\'t be placed', async () => {
    const moved = { reason: 'organization_binding_mismatch', path: 'messages.0.content.0' };
    const { said, order } = await run([withDrops(toolCall('c1'), [moved]), createMockResponse([{ type: 'text', text: 'Done.' }])]);
    assert.ok(order.includes('worker:text'), `premise: the call that dropped it and the last ran: ${order.join(' | ')}`);
    assert.deepEqual(said, []);
  });

  it('leaves a host\'s own strip observer in place, telling the resident nothing of it', async () => {
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
        assert.equal(given, strip);
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
