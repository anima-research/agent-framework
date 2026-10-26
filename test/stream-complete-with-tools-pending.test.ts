/**
 * A stream that completes while its round's tools still run: driveStream's
 * `complete` finds the agent waiting_for_tools, gives each call still running
 * an error result, and stores the round and its results. The results are
 * built first, as the ordinary tool boundary builds them, and a spill makes
 * that a workspace write; the round and its results are stored back to back
 * once it is done. A write that lands meanwhile and isn't deferred, here
 * another resident's answer in the shared slot, is stored when it lands,
 * before both, never between the round's tool_use and its result. (Before
 * this, the round was stored ahead of the build and its results after it, so
 * such a write landed between them.)
 *
 * While the results are built the round is still the agent's pending round,
 * and the agent is `ready` with every result in. A child derived then is
 * framed with the round and the results the agent holds: each that came in,
 * and the error result of each call still running. (Before, framePendingRound
 * read results only from a round waiting for its tools, so each call was
 * framed with a note that it was still running.)
 *
 * A message for prime that comes in meanwhile waits, as any write for an
 * agent whose turn is alive does, and is stored after the round and its
 * results, never between them.
 *
 * A stop or an operator's abandon that lands while the results are built
 * drops the round, as at an ordinary tool boundary: neither the round nor
 * its results is stored, one tool:result_dropped goes out for it, and the
 * stop's one inference:aborted ends the turn, with no inference:completed.
 * (Before, both were stored and the turn reported itself completed.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type {
  Agent,
  ContentBlock,
  TraceEvent,
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** `promise`, or a failure naming what was awaited once `ms` have passed. */
async function within<T>(label: string, promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Prime's round: two calls, `fetch`, whose result is over the inline cap
 *  and spills, and `slow`, which is still running when the stream completes. */
const ROUND: ContentBlock[] = [
  { type: 'text', text: 'Fetching both.' },
  { type: 'tool_use', id: 'call_fetch', name: 'canned--fetch', input: {} },
  { type: 'tool_use', id: 'call_slow', name: 'canned--slow', input: {} },
];

/**
 * A stream that yields its round's tool-calls event and then, once
 * `completeWhen` settles, completes without waiting for the round's results,
 * as a stream truncated after its calls can.
 */
class CompletesWhileToolsRun implements AsyncIterable<StreamEvent> {
  private waiting = true;
  private readonly cancelled = deferred();
  constructor(private readonly completeWhen: Promise<void>) {}
  provideToolResults(): void {
    throw new Error('Cannot provide tool results: this stream completes without them');
  }
  cancel(): void {
    this.waiting = false;
    this.cancelled.resolve();
  }
  get isWaitingForTools(): boolean { return this.waiting; }
  get pendingToolCallIds(): string[] { return this.waiting ? ['call_fetch', 'call_slow'] : []; }
  get toolDepth(): number { return 0; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield {
      type: 'tool-calls',
      calls: ROUND.flatMap((b) => b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []),
      context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '', roundContent: ROUND },
    } as unknown as StreamEvent;
    const ended = await Promise.race([this.completeWhen.then(() => 'complete' as const), this.cancelled.promise.then(() => 'cancelled' as const)]);
    this.waiting = false;
    if (ended === 'cancelled') {
      yield { type: 'aborted', reason: 'user' } as StreamEvent;
      return;
    }
    yield { type: 'complete', response: createMockResponse(ROUND, 'max_tokens') } as StreamEvent;
  }
}

/** Prime's first stream completes while its tools run; echo answers in text. */
class TwoResidentsMembrane extends MockMembrane {
  private primeStreams = 0;
  constructor(private readonly completeWhen: Promise<void>) { super(); }
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    if (String(request.system ?? '').includes('You are echo.')) {
      return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'echo answers' }])]);
    }
    if (this.primeStreams++ === 0) return new CompletesWhileToolsRun(this.completeWhen) as unknown as YieldingStream;
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'prime again' }])]);
  }
}

/** `fetch` answers at once with a payload over the inline cap; `slow`
 *  answers when the test lets it. An event that names echo wakes echo, and
 *  any other is a message for prime that wakes prime. */
class CannedModule implements Module {
  readonly name = 'canned';
  private readonly slowDone = deferred();
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> { this.slowDone.resolve(); }
  getTools(): ToolDefinition[] {
    return [
      { name: 'fetch', description: 'Returns a large payload.', inputSchema: { type: 'object', properties: {} } },
      { name: 'slow', description: 'Answers late.', inputSchema: { type: 'object', properties: {} } },
    ];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name === 'slow') {
      await this.slowDone.promise;
      return { success: true, data: 'late' };
    }
    return { success: true, data: 'x'.repeat(5_000) };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const { content, metadata } = event as unknown as { content: ContentBlock[]; metadata?: { wake?: string } };
    if (metadata?.wake === 'echo') return { requestInference: ['echo'] };
    return { addMessages: [{ participant: 'User', content }], requestInference: ['prime'] };
  }
  releaseSlow(): void { this.slowDone.resolve(); }
}

/** Holds the first spill write, prime's, until `open()`. A later one, such
 *  as a derived child's own copy of the same result, goes straight through. */
function holdSpills(workspace: WorkspaceModule): { entered: Promise<void>; written: Promise<void>; open: () => void } {
  const entered = deferred();
  const released = deferred();
  const written = deferred();
  const write = workspace.writeBinary.bind(workspace);
  let held = false;
  workspace.writeBinary = (async (...args: Parameters<typeof write>) => {
    if (held) return write(...args);
    held = true;
    entered.resolve();
    await released.promise;
    try {
      return await write(...args);
    } finally {
      written.resolve();
    }
  }) as typeof workspace.writeBinary;
  return { entered: entered.promise, written: written.promise, open: () => released.resolve() };
}

/** Each block in a window, in order: its type and its text or call id. */
function blocksOf(messages: unknown): string[] {
  return (messages as Array<{ content: Array<{ type: string; id?: string; toolUseId?: string; text?: string }> }>)
    .flatMap((m) => m.content.map((b) =>
      b.type === 'text' ? `text:${b.text}` : `${b.type}:${b.id ?? b.toolUseId}`));
}

/** Each `tool_result` block in a window, by its call id. */
function toolResultsOf(messages: Array<{ content: ContentBlock[] }>): Map<string, Extract<ContentBlock, { type: 'tool_result' }>> {
  return new Map(messages
    .flatMap((m) => m.content)
    .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
    .map((b) => [b.toolUseId, b]));
}

/**
 * Prime and echo, with prime's first stream completed while `slow` runs and
 * the spill of `fetch`'s result held: prime's round is pending and its
 * results are being built. `finish()` lets the spill write go on and `slow`
 * answer, and waits for both turns to end. `cleanup()` lets go of whatever
 * is held, stops the framework and removes its store.
 */
async function primeCompletedWhileSpillHeld(): Promise<{
  framework: AgentFramework;
  prime: Agent;
  /** Each block in prime's window, in order. */
  blocks: () => string[];
  finish: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), 'complete-with-tools-pending-'));
  const mountDir = join(tempDir, 'mount');
  mkdirSync(mountDir, { recursive: true });
  const completeWhen = deferred();
  const module = new CannedModule();
  const workspace = new WorkspaceModule({
    mounts: [{ name: 'files', path: mountDir, mode: 'read-write', watch: 'never' }],
  });
  const spills = holdSpills(workspace);
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: new TwoResidentsMembrane(completeWhen.promise).asMembrane(),
    agents: [
      { name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' },
      { name: 'echo', model: 'test-model', systemPrompt: 'You are echo.' },
    ],
    modules: [module, workspace as unknown as Module],
    syncIntervalMs: 0,
    toolResultInlineMaxChars: 1_000,
  });
  workspace.initStore(framework.getStore());
  const prime = framework.getAgent('prime')!;
  const echo = framework.getAgent('echo')!;
  const blocks = (): string[] => blocksOf(prime.getContextManager().queryMessages({}).messages);
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); warn(...args); };
  const cleanup = async (): Promise<void> => {
    console.warn = warn;
    module.releaseSlow();
    spills.open();
    await within('stop() in cleanup', framework.stop()).catch(() => {});
    rmSync(tempDir, { recursive: true, force: true });
  };
  try {
    framework.start();
    framework.pushEvent({
      type: 'external-message', source: 'test', content: [{ type: 'text', text: 'fetch both' }],
      metadata: {}, triggerInference: true,
    } as unknown as ProcessEvent);
    await waitFor("fetch's result to be in while slow runs", () => {
      const state = prime.state;
      return state.status === 'waiting_for_tools' && state.completed.some((c) => c.id === 'call_fetch');
    });
    completeWhen.resolve();
    await within("the spill of fetch's result to start", spills.entered);
    assert.ok(warned.some((w) => w.includes("'complete' event fired while agent 'prime' is still waiting_for_tools")),
      'the stream completed while the round waited for slow');
  } catch (err) {
    await cleanup();
    throw err;
  }
  return {
    framework,
    prime,
    blocks,
    finish: async () => {
      spills.open();
      await within('the spill write to finish', spills.written);
      module.releaseSlow();
      await waitFor('both turns to end', () =>
        framework.getHostModeStatus().activeTurns === 0 && prime.state.status === 'idle' && echo.state.status === 'idle');
    },
    cleanup,
  };
}

describe('a stream that completes while its tools run', () => {
  it("stores the round and its results back to back, and another resident's answer written while a result spills before both", async () => {
    const run = await primeCompletedWhileSpillHeld();
    const { framework, prime, blocks } = run;
    try {
      // Neither the round nor its results are in the slot yet: the round is
      // stored once its results are built. That is how this fix keeps the
      // two adjacent, not the property itself, so it isn't asserted here (a
      // fix that kept them adjacent another way would be as good). The
      // property is checked once both turns end.

      // Echo's turn runs and stores its answer while prime's spill is held.
      framework.pushEvent({
        type: 'external-message', source: 'test', content: [{ type: 'text', text: 'wake echo' }],
        metadata: { wake: 'echo' }, triggerInference: true,
      } as unknown as ProcessEvent);
      await waitFor("echo's answer to be stored", () => blocks().includes('text:echo answers'));

      await run.finish();

      const all = blocks();
      const round = all.indexOf('text:Fetching both.');
      assert.ok(round >= 0, "the round's text is stored");
      assert.deepEqual(all.slice(round, round + 3), ['text:Fetching both.', 'tool_use:call_fetch', 'tool_use:call_slow'],
        'the round: its text and both calls');
      assert.deepEqual(all.slice(round + 3, round + 5).sort(), ['tool_result:call_fetch', 'tool_result:call_slow'],
        'then both results, right after it');
      const echoed = all.indexOf('text:echo answers');
      assert.ok(echoed >= 0 && echoed < round,
        "echo's answer, written while the result spilled, is stored where it landed, before the round, not between the round and its results");

      const results = toolResultsOf(prime.getContextManager().queryMessages({}).messages);
      assert.match(String(results.get('call_slow')?.content), /Stream completed before tool result was received/, 'slow got the error result');
      assert.ok(String(results.get('call_fetch')?.content).length < 5_000, "fetch's result was stored spilled, not whole");
    } finally {
      await run.cleanup();
    }
  });

  it('frames the round for a child derived while its results are built with the results prime holds', async () => {
    const run = await primeCompletedWhileSpillHeld();
    const { framework, prime } = run;
    let kid: Awaited<ReturnType<AgentFramework['deriveAgent']>> | undefined;
    try {
      assert.equal(prime.state.status, 'ready', 'prime holds every result while they are built');
      kid = await within('the derive', framework.deriveAgent({ name: 'kid', from: 'prime' }));
      assert.deepEqual(framework.getPendingAssistantRound('prime')?.map((b) => b.type), ['text', 'tool_use', 'tool_use'],
        "prime's round is still pending once kid is derived: the derive ran inside the build");

      const messages = kid.contextManager.queryMessages({}).messages;
      const framed = messages.filter((m) =>
        (m.metadata as { kind?: string } | undefined)?.kind === 'dendrite-pending-round');
      assert.deepEqual(framed.map((m) => blocksOf([m])), [
        ['text:Fetching both.', 'tool_use:call_fetch', 'tool_use:call_slow'],
        ['tool_result:call_fetch', 'tool_result:call_slow'],
      ], "kid's branch has prime's round and then its results");
      assert.equal(messages[messages.indexOf(framed[0]!) + 1], framed[1], 'the results right after the round');

      const results = toolResultsOf(framed);
      const fetched = results.get('call_fetch')!;
      assert.notEqual(fetched.isError, true, "fetch's result is no error");
      assert.match(String(fetched.content), /^x{500}/, "fetch's result as prime received it");
      assert.ok(String(fetched.content).length < 5_000, 'spilled at the cap, as prime stores it');
      const slow = results.get('call_slow')!;
      assert.equal(slow.isError, true, "slow's result is an error");
      assert.match(String(slow.content), /Stream completed before tool result was received/,
        "slow's error result, given when the stream completed");
      assert.ok(!JSON.stringify(messages).includes('[No result yet'),
        'no call is framed as still running: every result was in');

      await run.finish();
      assert.equal(toolResultsOf(prime.getContextManager().queryMessages({}).messages).get('call_fetch')?.content,
        fetched.content, "kid was framed with the same copy of fetch's result that prime stored");
    } finally {
      try {
        kid?.cleanup();
      } finally {
        await run.cleanup();
      }
    }
  });

  it('stores a message for prime that comes in while its results are built after the round and its results', async () => {
    const run = await primeCompletedWhileSpillHeld();
    const { framework, blocks } = run;
    const queued = (framework as unknown as { deferredMessages: Array<{ content: ContentBlock[] }> }).deferredMessages;
    const said = (content: ContentBlock[]) => content.some((b) => b.type === 'text' && b.text === 'a word for prime');
    try {
      // A message for prime (CannedModule's onProcess stores an event that
      // names no agent as a message for prime, and wakes prime), taken in
      // while the spill is held: it is in the slot or waiting to be, which is
      // all this waits for. Where it lands is checked once the turns end.
      framework.pushEvent({
        type: 'external-message', source: 'test', content: [{ type: 'text', text: 'a word for prime' }],
        metadata: {}, triggerInference: true,
      } as unknown as ProcessEvent);
      await waitFor('the message for prime to be taken in', () =>
        blocks().includes('text:a word for prime') || queued.some((m) => said(m.content)));

      await run.finish();
      // It woke prime, whose next turn read it.
      await waitFor("prime's turn on the message to end", () =>
        blocks().includes('text:prime again') && framework.getHostModeStatus().activeTurns === 0);

      const all = blocks();
      const round = all.indexOf('text:Fetching both.');
      assert.ok(round >= 0, "the round's text is stored");
      assert.deepEqual(all.slice(round, round + 3), ['text:Fetching both.', 'tool_use:call_fetch', 'tool_use:call_slow'],
        'the round: its text and both calls');
      assert.deepEqual(all.slice(round + 3, round + 5).sort(), ['tool_result:call_fetch', 'tool_result:call_slow'],
        'then both results, right after it');
      assert.deepEqual(all.filter((b) => b === 'text:a word for prime'), ['text:a word for prime'], 'the message is stored once');
      assert.equal(all.indexOf('text:a word for prime'), round + 5, 'right after the results: after both, not between them');
      assert.ok(all.indexOf('text:prime again') > round + 5, "and prime's answer to it after it");
    } finally {
      await run.cleanup();
    }
  });
  for (const [label, stop, reason] of [
    ["a caller's stop", (framework: AgentFramework) => { assert.equal(framework.abortInference('prime', 'test'), true); }, 'test'],
    ["an operator's abandon", async (framework: AgentFramework) => {
      const quiesced = framework.quiesce({ abandon: true, timeoutMs: 1_000 });
      const marks = (framework as unknown as { frameworkCancelledStreams: Map<string, string> }).frameworkCancelledStreams;
      await waitFor('the abandon to cancel the stream', () => [...marks.values()].includes('quiesce_abandoned'));
      return quiesced;
    }, 'quiesce_abandoned'],
  ] as const) {
    it(`drops the round and its results when ${label} lands while its results are built`, async () => {
      const run = await primeCompletedWhileSpillHeld();
      const { framework, blocks } = run;
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); });
      const warn = console.warn;
      console.warn = () => {};
      try {
        const settled = await stop(framework);
        await run.finish();
        await within('the quiesce to return', Promise.resolve(settled));
        const all = blocks();
        for (const block of ['text:Fetching both.', 'tool_use:call_fetch', 'tool_use:call_slow', 'tool_result:call_fetch', 'tool_result:call_slow']) {
          assert.ok(!all.includes(block), `${block} is not stored`);
        }
        const forPrime = traces.filter((t) => (t as { agentName?: string }).agentName === 'prime');
        assert.deepEqual(forPrime.filter((t) => t.type === 'inference:aborted').map((t) => (t as { reason?: string }).reason), [reason],
          "the stop's one inference:aborted");
        assert.deepEqual(forPrime.filter((t) => t.type === 'inference:completed'), [], 'and the turn did not complete');
        const dropped = forPrime.filter((t): t is Extract<TraceEvent, { type: 'tool:result_dropped' }> =>
          t.type === 'tool:result_dropped' && /Stream completed before tool result/.test(String((t.result as { error?: unknown }).error)));
        assert.deepEqual(dropped.map((t) => t.callId), ['call_slow'], 'one tool:result_dropped for the round, its first call still running');
        const interrupted = all.filter((b) => b.startsWith('text:[turn-interrupted]'));
        assert.deepEqual(interrupted.length, reason === 'test' ? 1 : 0, "a caller's stop leaves its marker; an abandon leaves none");
        if (reason === 'test') assert.match(interrupted[0]!, /stopped before it finished/);
      } finally {
        console.warn = warn;
        await run.cleanup();
      }
    });
  }
});
