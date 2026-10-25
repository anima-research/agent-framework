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
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type {
  ContentBlock,
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

/** Holds each spill write until `open()`. */
function holdSpills(workspace: WorkspaceModule): { entered: Promise<void>; written: Promise<void>; open: () => void } {
  const entered = deferred();
  const released = deferred();
  const written = deferred();
  const write = workspace.writeBinary.bind(workspace);
  workspace.writeBinary = (async (...args: Parameters<typeof write>) => {
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

describe('a stream that completes while its tools run', () => {
  it("stores the round and its results back to back, and another resident's answer written while a result spills before both", async () => {
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
      assert.deepEqual(blocks().filter((b) => b.endsWith(':call_fetch') || b.endsWith(':call_slow')), [],
        "neither the round nor its results are in the slot while its results are built");

      // Echo's turn runs and stores its answer while prime's spill is held.
      framework.pushEvent({
        type: 'external-message', source: 'test', content: [{ type: 'text', text: 'wake echo' }],
        metadata: { wake: 'echo' }, triggerInference: true,
      } as unknown as ProcessEvent);
      await waitFor("echo's answer to be stored", () => blocks().includes('text:echo answers'));

      spills.open();
      await within('the spill write to finish', spills.written);
      module.releaseSlow();
      await waitFor('both turns to end', () =>
        framework.getHostModeStatus().activeTurns === 0 && prime.state.status === 'idle' && echo.state.status === 'idle');

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

      const results = prime.getContextManager().queryMessages({}).messages
        .flatMap((m) => m.content)
        .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
      const slow = results.find((b) => b.toolUseId === 'call_slow');
      assert.match(String(slow?.content), /Stream completed before tool result was received/, 'slow got the error result');
      const fetched = results.find((b) => b.toolUseId === 'call_fetch');
      assert.ok(String(fetched?.content).length < 5_000, "fetch's result was stored spilled, not whole");
    } finally {
      console.warn = warn;
      module.releaseSlow();
      spills.open();
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
