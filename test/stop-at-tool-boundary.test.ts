/**
 * A stop that lands at a tool boundary: the round's last result is in, the
 * agent reads `ready`, and the framework is storing the round (here an
 * oversized result spilling to the workspace) before it resumes the stream.
 * Agent.cancelStream() (what every connectome-host stop calls), stop(),
 * abortInference(), a quiesce's abandon and an ephemeral run's disposal end
 * the turn there as they do while the round's tools run: the stream is
 * cancelled, the round isn't resumed, restarted or stored, and the turn's
 * teardown runs. A quiesce's abandon does so whether or not driveStream has
 * read the stream's end before the write returns. A round nobody stops is
 * stored whole once its write is done.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Membrane as RealMembrane,
  NativeFormatter,
  type NormalizedRequest,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
  type YieldingStream,
  type YieldingStreamOptions,
} from '@animalabs/membrane';
import type {
  ContentBlock,
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ToolDefinition,
  ToolResult,
  TraceEvent,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

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

/** What one stream went through: whether a cancel ended it, and every
 *  provideToolResults attempt on it, refused ones included. */
class StreamRecord {
  cancelled = false;
  resumeAttempts = 0;
  private readonly ended = deferred();
  /** Settles when a cancel ends the stream. */
  readonly whenCancelled = this.ended.promise;
  constructor(private readonly onResumeAttempt: () => void) {}
  markCancelled(): void {
    this.cancelled = true;
    this.ended.resolve();
  }
  markResumeAttempt(): void {
    this.resumeAttempts++;
    this.onResumeAttempt();
  }
}

/** A mock whose streams, once cancelled, refuse results as membrane's own
 *  do (YieldingStreamImpl throws at status `done`). */
class StoppableMembrane extends MockMembrane {
  readonly streams: StreamRecord[] = [];
  onResumeAttempt = (): void => {};
  /** When set, a cancel refuses results at once, as membrane's does, but its
   *  `aborted` reaches the stream's reader only once this settles. */
  abortedAfter: Promise<void> | null = null;
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    const inner = super.streamYielding(request, options);
    const record = new StreamRecord(() => this.onResumeAttempt());
    this.streams.push(record);
    const abortedAfter = this.abortedAfter;
    return {
      cancel: () => {
        if (record.cancelled) return;
        record.markCancelled();
        if (abortedAfter) void abortedAfter.then(() => inner.cancel());
        else inner.cancel();
      },
      provideToolResults: (...args: unknown[]) => {
        record.markResumeAttempt();
        if (record.cancelled) throw new Error('Cannot provide tool results: stream is not waiting for tools (status: done)');
        (inner.provideToolResults as (...a: unknown[]) => void)(...args);
      },
      get isWaitingForTools() { return !record.cancelled && inner.isWaitingForTools; },
      get pendingToolCallIds() { return inner.pendingToolCallIds; },
      get toolDepth() { return inner.toolDepth; },
      [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](),
    } as unknown as YieldingStream;
  }
}

/** Membrane itself over a scripted provider, its streams observed but not
 *  changed: the round's cancel and its `aborted` are membrane's own. */
function scriptedMembrane(): { membrane: RealMembrane; streams: StreamRecord[]; requests: ProviderRequest[]; onResumeAttempt: { fn: () => void } } {
  const requests: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    name: 'test',
    usageCacheConvention: 'cache-excluded',
    supportsModel: () => true,
    complete: async () => { throw new Error('unexpected complete'); },
    stream: async (request: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(request);
      const first = requests.length === 1;
      return {
        content: first
          ? [{ type: 'text', text: 'Fetching.' }, { type: 'tool_use', id: 'call_fetch', name: 'canned--fetch', input: {} }]
          : [{ type: 'text', text: 'Handled.' }],
        stopReason: first ? 'tool_use' : 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'test-model',
      } as ProviderResponse;
    },
  };
  const membrane = new RealMembrane(adapter, { formatter: new NativeFormatter() });
  const streams: StreamRecord[] = [];
  const onResumeAttempt = { fn: (): void => {} };
  const open = membrane.streamYielding.bind(membrane);
  membrane.streamYielding = (request: NormalizedRequest, options?: YieldingStreamOptions): YieldingStream => {
    const stream = open(request, options);
    const record = new StreamRecord(() => onResumeAttempt.fn());
    streams.push(record);
    const cancelled = (): boolean => (stream as unknown as { isCancelled: boolean }).isCancelled;
    return new Proxy(stream, {
      get(target, key) {
        if (key === 'cancel') {
          return () => {
            const before = cancelled();
            target.cancel();
            if (!before && cancelled()) record.markCancelled();
          };
        }
        if (key === 'provideToolResults') {
          return (...args: Parameters<YieldingStream['provideToolResults']>) => {
            record.markResumeAttempt();
            return target.provideToolResults(...args);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return { membrane, streams, requests, onResumeAttempt };
}

/** A 1×1 PNG. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** One `fetch` tool whose result is over the inline cap, so it spills, and
 *  carries an image, which the framework retains in the agent's image ledger
 *  as it prepares the round's results. */
class OversizedResultModule implements Module {
  readonly name = 'canned';
  private ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'fetch', description: 'Returns a large payload.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    return {
      success: true,
      data: [
        { type: 'text', text: 'x'.repeat(5_000) },
        { type: 'image', data: PIXEL, mimeType: 'image/png' },
      ],
    };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
        requestInference: true,
      };
    }
    return {};
  }
  /** A message from outside the event loop, as a host API call adds one. */
  say(text: string): void {
    this.ctx!.addMessage('User', [{ type: 'text', text }]);
  }
}

/** Holds the round's spill write until `open()`, and keeps each path written. */
function holdSpills(workspace: WorkspaceModule): { entered: Promise<void>; written: Promise<void>; open: () => void; paths: string[] } {
  const entered = deferred();
  const released = deferred();
  const written = deferred();
  const paths: string[] = [];
  const write = workspace.writeBinary.bind(workspace);
  workspace.writeBinary = (async (...args: Parameters<typeof write>) => {
    paths.push(args[0]);
    entered.resolve();
    await released.promise;
    try {
      return await write(...args);
    } finally {
      written.resolve();
    }
  }) as typeof workspace.writeBinary;
  return { entered: entered.promise, written: written.promise, open: () => released.resolve(), paths };
}

/** Each block in a window, in order: its type and its text or call id. */
function blocksOf(messages: unknown): string[] {
  return (messages as Array<{ content: Array<{ type: string; id?: string; toolUseId?: string; text?: string; thinking?: string }> }>)
    .flatMap((m) => m.content.map((b) =>
      b.type === 'text' ? `text:${b.text}`
        : b.type === 'thinking' ? `thinking:${b.thinking}`
          : `${b.type}:${b.id ?? b.toolUseId}`));
}

/** The framework's image ledgers, by agent name. */
function imageLedgers(framework: AgentFramework): Map<string, { refFor(toolCallId: string, blockIndex: number): string | undefined }> {
  return (framework as unknown as { toolImageLedgers: Map<string, { refFor(toolCallId: string, blockIndex: number): string | undefined }> }).toolImageLedgers;
}

/** A round with thinking, text and two calls, each of whose results spills. */
const TWO_CALL_ROUND: ContentBlock[] = [
  { type: 'thinking', thinking: 'Both payloads are needed.', signature: 'sig-two-calls' } as ContentBlock,
  { type: 'text', text: 'Fetching both.' },
  { type: 'tool_use', id: 'call_fetch', name: 'canned--fetch', input: {} },
  { type: 'tool_use', id: 'call_fetch2', name: 'canned--fetch', input: {} },
];

/** The blocks of TWO_CALL_ROUND and its results, as a window shows them. */
const TWO_CALL_BLOCKS = new Set([
  'thinking:Both payloads are needed.', 'text:Fetching both.',
  'tool_use:call_fetch', 'tool_use:call_fetch2', 'tool_result:call_fetch', 'tool_result:call_fetch2',
]);

type Dropped = Extract<TraceEvent, { type: 'tool:result_dropped' }>;
const isDropped = (t: TraceEvent): t is Dropped => t.type === 'tool:result_dropped';

/** What the boundary did with the round, once it has done something. */
const DECISIONS = new Set(['tool:result_dropped', 'inference:stream_resumed', 'inference:stream_restarted']);

interface Boundary {
  framework: AgentFramework;
  module: OversizedResultModule;
  streams: StreamRecord[];
  requests: () => number;
  traces: TraceEvent[];
  /** Let the round's spill write finish, and wait until the boundary has
   *  dropped, resumed or restarted the round. */
  release: () => Promise<void>;
  /** Whether the turn has ended: no turn alive, the agent idle. */
  turnEnded: () => boolean;
  /** The round's rows in the agent's window: its tool_use or tool_result. */
  roundRows: () => string[];
  blocks: () => string[];
  /** What the workspace holds at the round's first spill path. */
  spilled: () => Promise<string>;
  /** stop(), bounded: a stream left running fails the test. */
  stop: () => Promise<void>;
  cleanup: () => Promise<void>;
}

interface HoldOptions {
  maxStreamTokens?: number;
  /** Membrane itself over a scripted provider, rather than the mock. */
  realMembrane?: boolean;
  /** The mock's answer comes on the turn's next stream, as after a restart,
   *  rather than on the first stream's resume: the mock gives a stream every
   *  response queued when it opens. */
  answerOnNextStream?: boolean;
  /** The mock's first round, rather than 'Fetching.' and one call. */
  firstRound?: ContentBlock[];
  /** The mock's: a cancel's `aborted` reaches driveStream only once this
   *  settles. */
  abortedAfter?: Promise<void>;
}

/** A turn held at its tool boundary: the round's one result is in and is
 *  being written to the workspace, with the write held until `release`. */
async function holdAtToolBoundary(options: HoldOptions = {}): Promise<Boundary> {
  const tempDir = mkdtempSync(join(tmpdir(), 'stop-at-boundary-'));
  const mountDir = join(tempDir, 'mount');
  mkdirSync(mountDir, { recursive: true });

  const decided = deferred();
  let membrane: RealMembrane;
  let streams: StreamRecord[];
  let requests: () => number;
  let queueAnswer = (): void => {};
  if (options.realMembrane) {
    const scripted = scriptedMembrane();
    scripted.onResumeAttempt.fn = () => decided.resolve();
    membrane = scripted.membrane;
    streams = scripted.streams;
    requests = () => scripted.requests.length;
  } else {
    const mock = new StoppableMembrane();
    mock.onResumeAttempt = () => decided.resolve();
    mock.abortedAfter = options.abortedAfter ?? null;
    mock.pushResponse(createMockResponse(options.firstRound ?? [
      { type: 'text', text: 'Fetching.' },
      { type: 'tool_use', id: 'call_fetch', name: 'canned--fetch', input: {} },
    ], 'tool_use'));
    queueAnswer = () => mock.pushResponse(createMockResponse([{ type: 'text', text: 'Handled.' }]));
    if (!options.answerOnNextStream) queueAnswer();
    membrane = mock.asMembrane();
    streams = mock.streams;
    requests = () => mock.calls.length;
  }

  const module = new OversizedResultModule();
  const workspace = new WorkspaceModule({
    mounts: [{ name: 'files', path: mountDir, mode: 'read-write', watch: 'never' }],
  });
  const spills = holdSpills(workspace);

  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane,
    agents: [{
      name: 'prime',
      model: 'test-model',
      systemPrompt: 'You are prime.',
      allowedTools: 'all',
      ...(options.maxStreamTokens !== undefined ? { maxStreamTokens: options.maxStreamTokens } : {}),
    }],
    modules: [module, workspace as unknown as Module],
    syncIntervalMs: 0,
    toolResultInlineMaxChars: 1_000,
  });
  workspace.initStore(framework.getStore());
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => {
    traces.push(event);
    if (DECISIONS.has(event.type)) decided.resolve();
  });
  framework.start();
  framework.pushEvent({
    type: 'external-message',
    source: 'test',
    content: [{ type: 'text', text: 'fetch it' }],
    metadata: {},
    triggerInference: true,
  } as unknown as ProcessEvent);
  await within("the round's spill write to start", spills.entered);
  if (options.answerOnNextStream) queueAnswer();

  const agent = framework.getAgent('prime')!;
  assert.equal(agent.state.status, 'ready', "the round's result is in and its boundary is storing it");
  const blocks = (): string[] => blocksOf(agent.getContextManager().queryMessages({}).messages);
  let cleaned = false;
  return {
    framework,
    module,
    streams,
    requests,
    traces,
    release: async () => {
      spills.open();
      await within('the spill write to finish', spills.written);
      await within('the boundary to drop, resume or restart the round', decided.promise);
    },
    turnEnded: () => framework.getHostModeStatus().activeTurns === 0 && agent.state.status === 'idle',
    roundRows: () => blocks().filter((b) => b.endsWith(':call_fetch')).map((b) => b.split(':')[0]),
    blocks,
    spilled: async () => {
      const read = await workspace.readBinary(spills.paths[0]);
      return 'data' in read ? read.data.toString('utf8') : `(${read.error})`;
    },
    stop: async () => { await within('stop() to finish', framework.stop()); },
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      spills.open();
      // Bounded, so a stream left parked fails its own test rather than
      // holding the file open; it says so here.
      await within('stop() in cleanup', framework.stop()).catch((error: unknown) => {
        console.error(`[test] ${error instanceof Error ? error.message : String(error)}: a stream was left running`);
      });
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function droppedOnce(traces: TraceEvent[], agentName: string): void {
  assert.deepEqual(
    traces.filter(isDropped).map((t) => [t.agentName, t.callId, t.agentStatus]),
    [[agentName, 'call_fetch', 'idle']],
    "one tool:result_dropped, for the round's call, with the agent idle",
  );
}

describe('a stop at a tool boundary', () => {
  it("a host's cancelStream ends the turn: the stream is cancelled, and the round isn't resumed or stored", async () => {
    const b = await holdAtToolBoundary();
    try {
      b.framework.getAgent('prime')!.cancelStream();
      assert.ok(b.streams[0].cancelled, 'the stop cancelled the stream');
      await b.release();

      assert.equal(b.streams[0].resumeAttempts, 0, 'the round was not resumed');
      assert.ok(!b.traces.some((t) => t.type === 'inference:stream_resumed'), 'no inference:stream_resumed');
      droppedOnce(b.traces, 'prime');
      await waitFor('the turn to end', b.turnEnded);
      assert.equal(b.requests(), 1, 'no other request was made');
      assert.deepEqual(b.roundRows(), [], 'the stopped round is not in the window, as for a stop while its tools run');
      assert.ok(!b.blocks().includes('text:Fetching.'), "nor is the round's text");
      assert.ok((await b.spilled()).includes('x'.repeat(5_000)), "the spilled result keeps its workspace file");
      assert.ok(imageLedgers(b.framework).get('prime')?.refFor('call_fetch', 1), "the result's image stays in the agent's image ledger");
      await b.stop();
    } finally {
      await b.cleanup();
    }
  });

  it("a host that cancels a `ready` agent's stream itself before cancelStream(), as connectome-host's subagent stop does, ends the turn the same way", async () => {
    // Membrane itself, so the boundary meets the stream as membrane leaves it.
    const b = await holdAtToolBoundary({ realMembrane: true });
    try {
      const agent = b.framework.getAgent('prime')!;
      const state = agent.state;
      if (state.status === 'ready' && state.stream) state.stream.cancel();
      agent.cancelStream();
      assert.ok(b.streams[0].cancelled, 'the stop cancelled the stream');
      await b.release();

      assert.equal(b.streams[0].resumeAttempts, 0, 'the round was not resumed');
      droppedOnce(b.traces, 'prime');
      await waitFor('the turn to end', b.turnEnded);
      assert.equal(b.requests(), 1, 'no other request was made');
      assert.deepEqual(b.roundRows(), [], 'the stopped round is not in the window');
      await b.stop();
    } finally {
      await b.cleanup();
    }
  });

  it('stop() cancels a turn held at its tool boundary', async () => {
    const b = await holdAtToolBoundary();
    try {
      const stopping = b.framework.stop();
      await within('stop() to cancel the stream', b.streams[0].whenCancelled);
      await b.release();
      await within('stop() to finish', stopping);

      assert.equal(b.streams[0].resumeAttempts, 0, 'the round was not resumed');
      assert.ok(!b.traces.some((t) => t.type === 'inference:stream_resumed'), 'no inference:stream_resumed');
      droppedOnce(b.traces, 'prime');
      assert.equal(b.requests(), 1, 'no other request was made');
      assert.equal(imageLedgers(b.framework).size, 0, "stop() discards the image ledgers, the result's image with them");
    } finally {
      await b.cleanup();
    }
  });

  it('abortInference aborts a turn held at its tool boundary', async () => {
    const b = await holdAtToolBoundary();
    try {
      assert.equal(b.framework.abortInference('prime', 'stopped at the boundary'), true, 'abortInference reports the abort');
      assert.ok(b.streams[0].cancelled, 'the abort cancelled the stream');
      await b.release();

      assert.equal(b.streams[0].resumeAttempts, 0, 'the round was not resumed');
      droppedOnce(b.traces, 'prime');
      await waitFor('the turn to end', b.turnEnded);
      assert.equal(b.requests(), 1, 'no other request was made');
      assert.deepEqual(b.roundRows(), [], 'the aborted round is not in the window');
      await b.stop();
    } finally {
      await b.cleanup();
    }
  });

  it("a quiesce's abandon at a boundary over budget doesn't restart the turn in the maintenance window", async () => {
    // Membrane itself over a scripted provider that reports 10 input tokens,
    // over this agent's budget of 5, so the boundary's next step would be a
    // budget restart, which runs even while the host is quiesced. The abandon
    // cancels the stream it reads from the agent's state, membrane delivers
    // `aborted`, and driveStream's quiesce case resets the agent, all before
    // the write returns.
    const b = await holdAtToolBoundary({ maxStreamTokens: 5, realMembrane: true });
    try {
      const status = await b.framework.quiesce({ timeoutMs: 1_000, abandon: true });
      assert.equal(status.quiesced, true);
      assert.ok(b.streams[0].cancelled, 'the abandon cancelled the stream');
      assert.equal(b.framework.getAgent('prime')!.state.status, 'idle', 'driveStream reset the agent before the write returned');
      await b.release();

      assert.ok(!b.traces.some((t) => t.type === 'inference:stream_restarted'), 'no inference:stream_restarted');
      assert.equal(b.streams[0].resumeAttempts, 0, 'the round was not resumed');
      droppedOnce(b.traces, 'prime');
      await waitFor('the turn to end', b.turnEnded);
      assert.equal(b.requests(), 1, 'no restart request was made');
      assert.deepEqual(b.roundRows(), [], 'the abandoned round is not in the window');
      await b.stop();
    } finally {
      await b.cleanup();
    }
  });

  for (const overBudget of [false, true]) {
    it(`a quiesce's abandon ends the round when driveStream reads the stream's end only after the boundary has decided${overBudget ? ', over budget' : ''}`, async () => {
      // Membrane delivers a cancel's `aborted` at once, so driveStream resets
      // the agent before the write returns (the test above). This stream's
      // `aborted` waits until the boundary has decided, so the boundary can't
      // rely on that order: it reads the framework's record of the abandon.
      const aborted = deferred();
      const b = await holdAtToolBoundary({
        abortedAfter: aborted.promise,
        ...(overBudget ? { maxStreamTokens: 5, answerOnNextStream: true } : {}),
      });
      try {
        const quiescing = b.framework.quiesce({ timeoutMs: 1_000, abandon: true });
        await within('the abandon to cancel the stream', b.streams[0].whenCancelled);
        assert.equal(b.framework.getAgent('prime')!.state.status, 'ready', "driveStream hasn't read the stream's end");
        await b.release();
        aborted.resolve();
        assert.equal((await within('the quiesce to finish', quiescing, 15_000)).quiesced, true);

        assert.equal(b.streams[0].resumeAttempts, 0, 'the round was not resumed');
        assert.ok(!b.traces.some((t) => t.type === 'inference:stream_restarted'), 'no inference:stream_restarted');
        assert.deepEqual(
          b.traces.filter(isDropped).map((t) => [t.agentName, t.callId, t.agentStatus]),
          [['prime', 'call_fetch', 'ready']],
          "one tool:result_dropped, for the round's call, before driveStream reset the agent",
        );
        await waitFor('the turn to end', b.turnEnded);
        assert.equal(b.requests(), 1, 'no other request was made');
        assert.deepEqual(b.roundRows(), [], 'the abandoned round is not in the window');
        await b.stop();
      } finally {
        aborted.resolve();
        await b.cleanup();
      }
    });
  }

  it("a stopped round of two calls stores none of its thinking, text, calls or results, and one tool:result_dropped names the result handled last", async () => {
    const b = await holdAtToolBoundary({ firstRound: TWO_CALL_ROUND });
    try {
      b.framework.getAgent('prime')!.cancelStream();
      await b.release();

      assert.equal(b.streams[0].resumeAttempts, 0, 'the round was not resumed');
      const completed = b.traces
        .filter((t): t is Extract<TraceEvent, { type: 'tool:completed' }> => t.type === 'tool:completed')
        .map((t) => t.callId);
      assert.deepEqual([...completed].sort(), ['call_fetch', 'call_fetch2'], 'both calls ran');
      assert.deepEqual(
        b.traces.filter(isDropped).map((t) => t.callId),
        [completed[completed.length - 1]],
        'one tool:result_dropped, for the result that made the round ready; the earlier one goes without one',
      );
      await waitFor('the turn to end', b.turnEnded);
      assert.equal(b.requests(), 1, 'no other request was made');
      assert.deepEqual(b.blocks().filter((x) => TWO_CALL_BLOCKS.has(x)), [], 'nothing of the round is in the window');
      await b.stop();
    } finally {
      await b.cleanup();
    }
  });

  it("an ephemeral run's disposal at its tool boundary cancels the stream, and the round isn't resumed or stored", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'stop-at-boundary-ephemeral-'));
    const mountDir = join(tempDir, 'mount');
    mkdirSync(mountDir, { recursive: true });
    const membrane = new StoppableMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Fetching.' },
      { type: 'tool_use', id: 'call_fetch', name: 'canned--fetch', input: {} },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Handled.' }]));
    const workspace = new WorkspaceModule({
      mounts: [{ name: 'files', path: mountDir, mode: 'read-write', watch: 'never' }],
    });
    const spills = holdSpills(workspace);
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new OversizedResultModule(), workspace as unknown as Module],
      syncIntervalMs: 0,
      toolResultInlineMaxChars: 1_000,
    });
    workspace.initStore(framework.getStore());
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    try {
      const { agent, contextManager } = await framework.createEphemeralAgent({
        name: 'worker',
        model: 'test-model',
        systemPrompt: 'Do the task.',
        allowedTools: 'all',
      });
      contextManager.addMessage('user', [{ type: 'text', text: 'fetch it' }]);
      // Its idle watchdog disposes the run while the round's write is held.
      const run = framework.runEphemeralToCompletion(agent, contextManager, { idleTimeoutMs: 300, idlePollMs: 50 });
      const ended = run.then(() => null, (error: unknown) => error);
      framework.start();
      await within("the round's spill write to start", spills.entered);
      assert.equal(agent.state.status, 'ready', "the round's result is in and its boundary is storing it");

      const error = await within('the run to be disposed', ended);
      assert.match(String(error), /stalled/, 'the watchdog ended the run');
      assert.ok(membrane.streams[0].cancelled, 'the disposal cancelled the stream');
      spills.open();
      await within('the spill write to finish', spills.written);
      await waitFor('the boundary to drop the round', () => traces.some(isDropped) || membrane.streams[0].resumeAttempts > 0);

      assert.equal(membrane.streams[0].resumeAttempts, 0, 'the round was not resumed');
      droppedOnce(traces, 'worker');
      assert.equal(membrane.calls.length, 1, 'no other request was made');
      assert.deepEqual(
        blocksOf(contextManager.queryMessages({}).messages).filter((b) => b.endsWith(':call_fetch')),
        [],
        'the disposed round is not in its window',
      );
      assert.equal(imageLedgers(framework).has('worker'), false, "the disposal discards the run's image ledger, the result's image with it");
      await within('stop() to finish', framework.stop());
    } finally {
      spills.open();
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('a tool boundary nobody stops', () => {
  it("stores the round's tool_use with its results once the write is done, and a message sent meanwhile after them", async () => {
    const b = await holdAtToolBoundary();
    try {
      // While the write runs, the turn is alive, so the message is deferred.
      b.module.say('meanwhile');
      assert.deepEqual(b.roundRows(), [], "neither of the round's rows is in the window while its write runs");
      await b.release();

      assert.ok(b.traces.some((t) => t.type === 'inference:stream_resumed'), 'the round was resumed');
      await waitFor('the turn to end', b.turnEnded);
      const blocks = b.blocks();
      const toolUse = blocks.indexOf('tool_use:call_fetch');
      assert.ok(toolUse >= 0, "the round's tool_use is stored");
      assert.equal(blocks[toolUse + 1], 'tool_result:call_fetch', 'its result is stored right after it');
      assert.ok(blocks.indexOf('text:meanwhile') > toolUse + 1, 'the message sent during the write lands after the round');
      assert.equal(b.traces.filter(isDropped).length, 0, 'nothing was dropped');
      await b.stop();
    } finally {
      await b.cleanup();
    }
  });

  it('stores a round of two calls whole: its thinking, text and calls, then both results', async () => {
    const b = await holdAtToolBoundary({ firstRound: TWO_CALL_ROUND });
    try {
      await b.release();

      assert.ok(b.traces.some((t) => t.type === 'inference:stream_resumed'), 'the round was resumed');
      await waitFor('the turn to end', b.turnEnded);
      const blocks = b.blocks();
      const start = blocks.indexOf('thinking:Both payloads are needed.');
      assert.ok(start >= 0, "the round's thinking is stored");
      assert.deepEqual(
        blocks.slice(start, start + 4),
        ['thinking:Both payloads are needed.', 'text:Fetching both.', 'tool_use:call_fetch', 'tool_use:call_fetch2'],
        'its thinking, text and calls, in order',
      );
      assert.deepEqual(blocks.slice(start + 4, start + 6).sort(), ['tool_result:call_fetch', 'tool_result:call_fetch2'], 'then both results');
      assert.equal(b.traces.filter(isDropped).length, 0, 'nothing was dropped');
      await b.stop();
    } finally {
      await b.cleanup();
    }
  });

  it("a cancel recorded under the stream's key that wasn't this stream's drops nothing", async () => {
    const b = await holdAtToolBoundary();
    try {
      // One recorded against an earlier agent of the same name would sit
      // under this key, since that agent numbered its streams from 1 too.
      // This stream is still waiting for its results.
      const agent = b.framework.getAgent('prime')!;
      (b.framework as unknown as { frameworkCancelledStreams: Map<string, string> })
        .frameworkCancelledStreams.set(`prime:${agent.streamId}`, 'quiesce_abandoned');
      await b.release();

      assert.ok(b.traces.some((t) => t.type === 'inference:stream_resumed'), 'the round was resumed');
      assert.equal(b.traces.filter(isDropped).length, 0, 'nothing was dropped');
      await waitFor('the turn to end', b.turnEnded);
      const blocks = b.blocks();
      const toolUse = blocks.indexOf('tool_use:call_fetch');
      assert.ok(toolUse >= 0, "the round's tool_use is stored");
      assert.equal(blocks[toolUse + 1], 'tool_result:call_fetch', 'with its result right after it');
      await b.stop();
    } finally {
      await b.cleanup();
    }
  });

  it('a boundary over budget restarts the turn, and the restart cancels the stream it replaces', async () => {
    const b = await holdAtToolBoundary({ maxStreamTokens: 5, answerOnNextStream: true });
    try {
      await b.release();

      assert.ok(b.traces.some((t) => t.type === 'inference:stream_restarted'), 'the boundary restarted the turn');
      assert.ok(b.streams[0].cancelled, 'the restart cancelled the stream it replaced');
      assert.equal(b.streams[0].resumeAttempts, 0, 'the replaced stream was not resumed');
      await waitFor('the turn to end', b.turnEnded);
      assert.equal(b.requests(), 2, 'the restart made one request');
      await b.stop();
    } finally {
      await b.cleanup();
    }
  });
});
