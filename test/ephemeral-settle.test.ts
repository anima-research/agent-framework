import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, YieldingStream } from '@animalabs/membrane';
import type {
  ErrorAction,
  ErrorPolicy,
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework, ShutdownTimeoutError } from '../src/index.js';
import { createMockResponse, HeldStream, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';
import { UNREACHED_WATCHDOG, silenceRun } from './helpers/run-watchdog.js';

class EphemeralToolModule implements Module {
  readonly name = 'test';
  readonly calls: ToolCall[] = [];

  constructor(private readonly endTurnTool = 'finish') {}

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'echo',
        description: 'Echo input',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      },
      {
        name: this.endTurnTool,
        description: 'Finish the turn',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    const baseName = call.name.includes('--')
      ? call.name.slice(call.name.lastIndexOf('--') + 2)
      : call.name;
    if (baseName === this.endTurnTool) {
      return { success: true, data: { finished: true }, endTurn: true };
    }
    return { success: true, data: { echoed: call.input } };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }
}

/** A tool that, while its call runs, has `duringCall` run: there, a test
 *  addresses the run as the event gate does, through the framework's
 *  addMessage with `forAgent`, or writes as a module does, through its
 *  context (`ctx`). */
class DuringCallToolModule implements Module {
  readonly name = 'test';
  ctx: ModuleContext | null = null;
  duringCall: (() => void) | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: {} } }];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.duringCall?.();
    return { success: true, data: { ok: true } };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }
}

class ThrowingMembrane extends MockMembrane {
  readonly errors: Error[];

  constructor(errors: Error[]) {
    super();
    this.errors = [...errors];
  }

  streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    throw this.errors.shift() ?? new Error('unexpected stream attempt');
  }
}

class RetryOncePolicy implements ErrorPolicy {
  maxRetries = 1;

  onInferenceError(_error: Error, _agentName: string, attempt: number): ErrorAction {
    if (attempt < this.maxRetries) {
      return { retry: true, delayMs: 0 };
    }
    return { retry: false };
  }
}

function tempStorePath(prefix: string): { tempDir: string; storePath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  return { tempDir, storePath: join(tempDir, 'store.chronicle') };
}

async function createEphemeral(
  framework: AgentFramework,
  name = 'worker',
) {
  const created = await framework.createEphemeralAgent({
    name,
    model: 'test-model',
    systemPrompt: 'Do the task.',
    allowedTools: 'all',
  });
  created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
  return created;
}

async function runStartedEphemeral(
  framework: AgentFramework,
  agent: Awaited<ReturnType<typeof createEphemeral>>['agent'],
  contextManager: Awaited<ReturnType<typeof createEphemeral>>['contextManager'],
  watchdogs?: Parameters<AgentFramework['runEphemeralToCompletion']>[2],
) {
  const promise = framework.runEphemeralToCompletion(agent, contextManager, watchdogs);
  framework.start();
  return promise;
}

// For a run that stop() is to end: its turn has started inference, so if
// stop() didn't end it, only the idle watchdog would, after fifteen minutes.
// A short one turns that into a "stalled" rejection, which the refusal's
// pattern doesn't match.
const STOPPED_RUN_WATCHDOGS = { idleTimeoutMs: 20_000, idlePollMs: 50 };

/** The store throws when asked for this agent's turn checkpoints. */
function failCheckpointReads(framework: AgentFramework, agentName: string): void {
  const store = framework.getStore();
  const treeGet = store.treeGet.bind(store);
  (store as unknown as { treeGet: typeof treeGet }).treeGet = (treeId, key) => {
    if (treeId === 'framework/turn-checkpoints/tree' && key === agentName) throw new Error('injected checkpoint store failure');
    return treeGet(treeId, key);
  };
}

async function stopAndRemove(framework: AgentFramework, tempDir: string): Promise<void> {
  await framework.stop();
  rmSync(tempDir, { recursive: true, force: true });
}

describe('runEphemeralToCompletion settle signal', () => {
  it('a run whose turn stop() refuses ends during stop(), and a run asked for once stop() has begun is refused', { timeout: 60_000 }, async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-stopping-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'too late' }]));
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      syncIntervalMs: 0,
    });
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const later = await createEphemeral(framework, 'later');
      // Hold the run's compile until stop() has begun.
      let compiling!: () => void;
      const inCompile = new Promise<void>((resolve) => { compiling = resolve; });
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const start = agent.startStreamWithInjections.bind(agent);
      (agent as unknown as { startStreamWithInjections: typeof start }).startStreamWithInjections = async (...args) => {
        compiling();
        await released;
        return start(...args);
      };
      const run = runStartedEphemeral(framework, agent, contextManager, STOPPED_RUN_WATCHDOGS);
      await inCompile;
      const stopped = framework.stop();
      release();
      await assert.rejects(run, /refused: the framework is stopping/);
      await stopped;
      await assert.rejects(
        framework.runEphemeralToCompletion(later.agent, later.contextManager),
        /framework is stopping: refusing new ephemeral run/,
      );
      later.cleanup();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a run whose turn waits on its modules' context when stop() begins ends during stop(), and sends nothing", { timeout: 60_000 }, async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-stopping-precompile-');
    let gathering!: () => void;
    const inGather = new Promise<void>((resolve) => { gathering = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const contextModule: Module = new EphemeralToolModule();
    contextModule.gatherContext = async () => {
      gathering();
      await released;
      return [];
    };
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [contextModule],
      syncIntervalMs: 0,
    });
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const run = runStartedEphemeral(framework, agent, contextManager, STOPPED_RUN_WATCHDOGS);
      await inGather;
      const stopped = framework.stop();
      release();
      await assert.rejects(run, /refused: the framework is stopping/);
      await stopped;
      assert.equal(membrane.calls.length, 0, 'the turn sent nothing');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a run waiting to retry when stop() begins gives up before its turn starts again, and ends during stop()', { timeout: 60_000 }, async () => {
    // stop() ends the retry's wait, which cancels the retry before its turn
    // starts again; the run ends during stop(), not when its idle watchdog
    // fires.
    const { tempDir, storePath } = tempStorePath('ephemeral-retry-stopping-');
    let waiting!: () => void;
    const inDelay = new Promise<void>((resolve) => { waiting = resolve; });
    let gathered = 0;
    const contextModule: Module = new EphemeralToolModule();
    contextModule.gatherContext = async () => {
      gathered++;
      return [];
    };
    const framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [],
      modules: [contextModule],
      syncIntervalMs: 0,
      errorPolicy: {
        maxRetries: 1,
        onInferenceError: (_error: Error, _agent: string, attempt: number): ErrorAction => {
          waiting();
          // Long enough that only stop() ends the wait.
          return attempt < 1 ? { retry: true, delayMs: 60_000 } : { retry: false };
        },
      },
    });
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      let compiles = 0;
      (agent as unknown as { startStreamWithInjections: () => Promise<never> }).startStreamWithInjections = async () => {
        compiles++;
        throw new Error('boom');
      };
      const run = runStartedEphemeral(framework, agent, contextManager, STOPPED_RUN_WATCHDOGS);
      await inDelay;
      const stopped = framework.stop();
      await assert.rejects(run, /refused: the framework is stopping/);
      await stopped;
      assert.equal(compiles, 1, 'the retry was refused, not compiled');
      assert.equal(gathered, 1, 'the retry was refused before its turn started');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a run whose stream failed and waits to retry ends during stop()', { timeout: 60_000 }, async () => {
    // The stream's own retry: stop() ends its wait and cancels it there.
    const { tempDir, storePath } = tempStorePath('ephemeral-stream-retry-stopping-');
    let waiting!: () => void;
    const inDelay = new Promise<void>((resolve) => { waiting = resolve; });
    const membrane = new MockMembrane();
    membrane.streamYielding = (request) => {
      membrane.calls.push(request);
      // A stream that fails once it has started.
      const stream = new MockYieldingStream([]);
      (stream as unknown as { events: unknown[] }).events.push({ type: 'error', error: new Error('overloaded') });
      return stream;
    };
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      syncIntervalMs: 0,
      errorPolicy: {
        maxRetries: 1,
        onInferenceError: (_error: Error, _agent: string, attempt: number): ErrorAction => {
          waiting();
          // Long enough that only stop() ends the wait.
          return attempt < 1 ? { retry: true, delayMs: 60_000 } : { retry: false };
        },
      },
    });
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const run = runStartedEphemeral(framework, agent, contextManager, STOPPED_RUN_WATCHDOGS);
      await inDelay;
      const stopped = framework.stop();
      await assert.rejects(run, /refused: the framework is stopping/);
      await stopped;
      assert.equal(membrane.calls.length, 1, 'the retry was not compiled');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a run whose wake the event loop hasn't taken up when stop() begins ends during stop(), not at its startup watchdog", { timeout: 60_000 }, async () => {
    // The run is asked for and stop() begins in the same tick. Nothing is
    // queued for the loop, so it isn't handling an event, the one place it
    // still takes a wake up after stop() has stopped it: the run's wake stays
    // untaken, and no turn of the run's starts or is refused (#335).
    const { tempDir, storePath } = tempStorePath('ephemeral-untaken-wake-');
    let gathered = 0;
    const contextModule: Module = new EphemeralToolModule();
    contextModule.gatherContext = async () => {
      gathered++;
      return [];
    };
    const framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [],
      modules: [contextModule],
      syncIntervalMs: 0,
    });
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      framework.start();
      // A startup watchdog the test outlasts: if stop() didn't end the run,
      // the watchdog would fire after stop() had closed the store, and the
      // run's cleanup, writing to that store, would throw "Store has been
      // closed" in place of the watchdog's refusal, which the pattern doesn't
      // match.
      const run = framework.runEphemeralToCompletion(agent, contextManager, { startupTimeoutMs: 5_000 });
      const stopped = framework.stop();
      await assert.rejects(run, /refused: the framework is stopping/);
      await stopped;
      const pending = (framework as unknown as { pendingRequests: Array<{ agentName: string }> }).pendingRequests;
      assert.ok(pending.some((request) => request.agentName === agent.name), 'the loop never took the wake up');
      assert.equal(gathered, 0, 'no turn of the run started');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** A resident whose stream stop() has to wait for, until the test releases it. */
  async function frameworkHeldByAResident(storePath: string, released: Promise<void>, options: {
    workerStream?: () => YieldingStream;
    errorPolicy?: ErrorPolicy;
  } = {}) {
    let streaming!: () => void;
    const residentStreaming = new Promise<void>((resolve) => { streaming = resolve; });
    let slow!: () => void;
    const inSlowEvent = new Promise<void>((resolve) => { slow = resolve; });
    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const membrane = new MockMembrane();
    membrane.streamYielding = (request) => {
      membrane.calls.push(request);
      if (JSON.stringify(request.system ?? '').includes('Do the task.')) {
        return options.workerStream?.() ?? new MockYieldingStream([createMockResponse([{ type: 'text', text: 'worker ran' }])]);
      }
      streaming();
      return new HeldStream(released, [createMockResponse([{ type: 'text', text: 'resident done' }])]);
    };
    const events: Module = {
      name: 'events',
      async start() {},
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: true }; },
      async onProcess(event) {
        if (event.type !== 'external-message') return {};
        const text = String((event as { content?: unknown }).content);
        if (text === 'slow') {
          slow();
          await slowReleased;
          return {};
        }
        return { addMessages: [{ participant: 'User', content: [{ type: 'text', text }] }], requestInference: true };
      },
    };
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
      modules: [events],
      syncIntervalMs: 0,
      ...(options.errorPolicy ? { errorPolicy: options.errorPolicy } : {}),
    });
    const push = (content: string) =>
      framework.pushEvent({ type: 'external-message', source: 'test', content, metadata: {} } as unknown as ProcessEvent);
    return { framework, membrane, residentStreaming, inSlowEvent, releaseSlow, push };
  }

  it("a run whose turn stop() refuses ends with the refusal when its startup watchdog fires before stop()'s sweep", { timeout: 60_000 }, async (t) => {
    // stop() waits on a resident's stream until the test releases it, so its
    // sweep comes after that. Meanwhile the loop, finishing a slow event,
    // takes the run's wake up and refuses its turn, and then the run's
    // startup watchdog fires. Once stop() has begun, it says why the run
    // ended, the framework is stopping, and what it saw, but blames no
    // stalled loop.
    const { tempDir, storePath } = tempStorePath('ephemeral-held-stop-startup-');
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const { framework, membrane, residentStreaming, inSlowEvent, releaseSlow, push } = await frameworkHeldByAResident(storePath, released);
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      framework.start();
      push('go');
      await residentStreaming;
      push('slow');
      await inSlowEvent;
      // The run's startup watchdog stays a real timer, but its callback waits
      // until the loop has taken the run's wake up, since the loop can still
      // be in the slow event when the timer comes due. The run sets the
      // watchdog as it starts, before its first await.
      const realSetTimeout = globalThis.setTimeout;
      let wakeTaken!: () => void;
      const taken = new Promise<void>((resolve) => { wakeTaken = resolve; });
      let watchdogs = 0;
      const timers = t.mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (ms !== 40) return realSetTimeout(callback, ms, ...args);
        watchdogs += 1;
        return realSetTimeout(() => { void taken.then(() => callback(...args)); }, ms);
      }) as unknown as typeof setTimeout);
      const run = framework.runEphemeralToCompletion(agent, contextManager, { startupTimeoutMs: 40 });
      timers.mock.restore();
      // A failure below is then reported alone, without the run's own
      // rejection once stop()'s sweep ends it.
      void run.catch(() => {});
      assert.equal(watchdogs, 1, 'the run set its startup watchdog as it started');
      const pending = () => (framework as unknown as { pendingRequests: Array<{ agentName: string }> }).pendingRequests;
      assert.ok(pending().some((request) => request.agentName === agent.name), "the run's wake is queued");
      const stopped = framework.stop();
      releaseSlow();
      const deadline = performance.now() + 30_000;
      while (pending().some((request) => request.agentName === agent.name)) {
        assert.ok(performance.now() < deadline, "the loop didn't take the run's wake up within 30 s");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      wakeTaken();
      // The held stream is released only after this, so the sweep can't have
      // ended the run.
      await assert.rejects(run, /refused: the framework is stopping \(inference not started within 40ms\)/);
      release();
      await stopped;
      assert.equal(membrane.calls.length, 1, "the run's turn sent nothing");
    } finally {
      releaseSlow();
      release();
      // A check that failed before stop() would leave the framework running
      // over a store about to be removed.
      await framework.stop().catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a run whose retry stop() cancels ends with the refusal when its idle watchdog fires before stop()'s sweep", { timeout: 60_000 }, async () => {
    // The run's stream can't start, and stop() cancels its retry while it
    // waits on a resident's stream. The run's inference had started, so its
    // idle watchdog is the one that fires, once the test makes the run look
    // idle, and before stop()'s sweep.
    const { tempDir, storePath } = tempStorePath('ephemeral-held-stop-idle-');
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let waiting!: () => void;
    const inDelay = new Promise<void>((resolve) => { waiting = resolve; });
    const { framework, membrane, residentStreaming, push } = await frameworkHeldByAResident(storePath, released, {
      workerStream: () => { throw new Error('the stream could not start'); },
      errorPolicy: {
        maxRetries: 1,
        onInferenceError: (_error: Error, _agent: string, attempt: number): ErrorAction => {
          waiting();
          // Long enough that only stop() ends the wait.
          return attempt < 1 ? { retry: true, delayMs: 60_000 } : { retry: false };
        },
      },
    });
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      framework.start();
      push('go');
      await residentStreaming;
      const run = framework.runEphemeralToCompletion(agent, contextManager, UNREACHED_WATCHDOG);
      await inDelay;
      const stopped = framework.stop();
      // stop() has closed admission before it returns, so the watchdog's
      // next poll ends the run as a stop.
      silenceRun(framework, agent.name);
      // As above: the held stream is released only after this.
      await assert.rejects(run, /refused: the framework is stopping \(no stream-driver activity for \d+s after inference started\)/);
      release();
      await stopped;
      assert.equal(membrane.calls.length, 2, 'the resident streamed once, and the run tried once and was not retried');
    } finally {
      release();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('an idle watchdog that fires with no stop() under way keeps its stall diagnosis', { timeout: 60_000 }, async () => {
    // The run's stream starts and then yields nothing. Only once stop() has
    // begun does the idle watchdog give the refusal instead.
    const { tempDir, storePath } = tempStorePath('ephemeral-idle-no-stop-');
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const membrane = new MockMembrane();
    membrane.streamYielding = (request) => {
      membrane.calls.push(request);
      return new HeldStream(released, [createMockResponse([{ type: 'text', text: 'too late' }])]);
    };
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      syncIntervalMs: 0,
    });
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      framework.start();
      const run = framework.runEphemeralToCompletion(agent, contextManager, UNREACHED_WATCHDOG);
      const deadline = performance.now() + 30_000;
      while (membrane.calls.length === 0) {
        assert.ok(performance.now() < deadline, "the run's stream wasn't requested within 30 s");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      silenceRun(framework, agent.name);
      await assert.rejects(run, /stalled: no stream-driver activity for \d+s after inference started .*Stream likely dropped/);
      assert.equal(membrane.calls.length, 1, 'the run streamed once');
    } finally {
      release();
      await stopAndRemove(framework, tempDir);
    }
  });

  it("a run whose stream outlasts stop()'s budget is ended by that stop() with its queue stored, and a later stop() waits for its stream", { timeout: 60_000 }, async () => {
    // The run's stream yields nothing until the test releases it, cancel
    // included, so stop(100)'s wait on it runs out. The caller asked for a
    // bounded stop(), so its sweep ends the run then, rather than leave it to
    // its idle watchdog, fifteen minutes by default, and the run's end stores
    // what was queued for it, as at any run's end. The run's end removes its
    // stream's activeStreams entry, but the stream is still running, so a
    // second stop() waits for it too and keeps the store open until it has
    // settled. Once it does, what it yields late is dropped: the run has left.
    const { tempDir, storePath } = tempStorePath('ephemeral-stop-budget-');
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const membrane = new MockMembrane();
    membrane.streamYielding = (request) => {
      membrane.calls.push(request);
      return new HeldStream(released, [createMockResponse([{ type: 'text', text: 'too late' }])]);
    };
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      syncIntervalMs: 0,
    });
    const within = <T>(promise: Promise<T>): Promise<unknown> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        promise.then(() => 'resolved', (error: unknown) => error),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still pending'), 5_000); }),
      ]).finally(() => clearTimeout(timer));
    };
    const internals = framework as unknown as {
      activeStreams: Map<string, unknown>;
      leftRunning: Map<Promise<unknown>, unknown>;
      addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: undefined, opts?: { forAgent?: string }): string;
    };
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const stored = (): string[] => contextManager.getAllMessages()
        .flatMap((m) => m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)));
      framework.start();
      const run = framework.runEphemeralToCompletion(agent, contextManager);
      void run.catch(() => {});
      for (let i = 0; i < 400 && !internals.activeStreams.has(agent.name); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(internals.activeStreams.has(agent.name), "the run's stream started");
      assert.equal(internals.addMessage('Antra', [{ type: 'text', text: 'look left' }], undefined, { forAgent: agent.name }), '',
        'deferred: the run is streaming');
      const stopped = await within(framework.stop(100));
      assert.ok(stopped instanceof ShutdownTimeoutError
        && stopped.message === `Shutdown timed out after 100 ms; pending: stream:${agent.name}`, String(stopped));
      const ended = await within(run);
      assert.ok(ended instanceof Error && /refused: the framework is stopping/.test(ended.message), String(ended));
      assert.equal(framework.getAgent(agent.name), null, 'the run has left');
      assert.ok(stored().includes('look left'), `its end stored its queue:\n${stored().join('\n')}`);
      const again = await within(framework.stop(100));
      assert.ok(again instanceof ShutdownTimeoutError
        && again.message === `Shutdown timed out after 100 ms; pending: stream:${agent.name}`, String(again));
      assert.equal(framework.getStore().isClosed(), false, 'the run\'s stream is still running');
      release();
      for (let i = 0; i < 400 && internals.leftRunning.size > 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(internals.leftRunning.size, 0, 'the stream settled');
      assert.ok(!stored().includes('too late'), `what it yielded once the run had left was dropped:\n${stored().join('\n')}`);
      await framework.stop();
      assert.equal(framework.getStore().isClosed(), true, 'and a stop() closes the store once it has');
    } finally {
      release();
      await stopAndRemove(framework, tempDir);
    }
  });

  it('resolves plain text completion and deregisters the agent', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-plain-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Plain final answer' }]));

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      syncIntervalMs: 0,
    });

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const result = await runStartedEphemeral(framework, agent, contextManager);

      assert.deepStrictEqual(result, {
        speech: 'Plain final answer',
        toolCallsCount: 0,
      });
      assert.strictEqual(framework.getAgent(agent.name), null);
      const internals = framework as unknown as {
        turnRouting: Map<string, unknown>; proseSpeechChains: Map<string, unknown>;
      };
      assert.equal(internals.turnRouting.has(agent.name), false, 'disposal removes turn routing');
      assert.equal(internals.proseSpeechChains.has(agent.name), false, 'disposal removes the speech chain');
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('a run whose turn checkpoints the store fails to remove still resolves with its speech, and the failure is logged', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-evict-fails-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Plain final answer' }]));
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      syncIntervalMs: 0,
    });
    const errors = mock.method(console, 'error', () => {});
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      // The turn's start reads the agent's checkpoints before its stream, so
      // the store fails from the stream on, and the removal's read is the
      // next to ask.
      const streamYielding = membrane.streamYielding.bind(membrane);
      membrane.streamYielding = (request, options) => {
        failCheckpointReads(framework, agent.name);
        return streamYielding(request, options);
      };
      const result = await runStartedEphemeral(framework, agent, contextManager);

      assert.deepStrictEqual(result, { speech: 'Plain final answer', toolCallsCount: 0 });
      assert.strictEqual(framework.getAgent(agent.name), null);
      const internals = framework as unknown as { activeTurnTokens: Map<string, unknown> };
      assert.equal(internals.activeTurnTokens.has(agent.name), false, 'the teardown went on past the failure');
      const lines = errors.mock.calls.map((call) => String(call.arguments[0]));
      assert.ok(
        lines.some((line) => line.startsWith(`[checkpoints] agent=${agent.name}: removing its turn checkpoints from the store failed`)
          && line.includes('injected checkpoint store failure')),
        lines.join('\n'),
      );
    } finally {
      errors.mock.restore();
      await stopAndRemove(framework, tempDir);
    }
  });

  it('resolves after tool rounds with final speech and dispatched call count', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-tools-');
    const membrane = new MockMembrane();
    const tools = new EphemeralToolModule();

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Using the first tool.' },
      { type: 'tool_use', id: 'call_1', name: 'test--echo', input: { message: 'one' } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Using the second tool.' },
      { type: 'tool_use', id: 'call_2', name: 'test--echo', input: { message: 'two' } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Post-tool final answer' },
    ]));

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [tools],
      syncIntervalMs: 0,
    });

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const result = await runStartedEphemeral(framework, agent, contextManager);

      assert.deepStrictEqual(result, {
        speech: 'Post-tool final answer',
        toolCallsCount: 2,
      });
      assert.strictEqual(tools.calls.length, 2);
      assert.strictEqual(framework.getAgent(agent.name), null);
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('what is queued for a run when it ends is stored in its namespace, not dropped once it is deregistered', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-queued-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_1', name: 'test--echo', input: {} },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));

    const tools = new DuringCallToolModule();
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [tools],
      syncIntervalMs: 0,
    });
    // While the run's tool call is pending, two messages for it are deferred:
    // one named as the run itself, which waits for its turn's end, and one
    // queued behind it.
    const internals = framework as unknown as {
      addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: undefined, opts?: { forAgent?: string }): string;
    };
    tools.duringCall = () => {
      internals.addMessage('worker', [{ type: 'text', text: 'my own words' }], undefined, { forAgent: 'worker' });
      internals.addMessage('Antra', [{ type: 'text', text: 'look left' }], undefined, { forAgent: 'worker' });
    };

    try {
      const { agent, contextManager } = await createEphemeral(framework, 'worker');
      const result = await runStartedEphemeral(framework, agent, contextManager);
      assert.strictEqual(result.speech, 'Done.');
      assert.strictEqual(framework.getAgent(agent.name), null, 'deregistered');
      const stored = contextManager.getAllMessages().map((m) =>
        `${m.participant}: ${m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join(' ')}`);
      assert.deepStrictEqual(stored.slice(-3), ['worker: Done.', 'worker: my own words', 'Antra: look left'],
        'held to the turn end, and stored after the run\'s last reply');
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it("a module's write with no target, which a host with no primary sends to its run, is the run's: stored in its namespace, with nothing left queued once it ends", async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-untargeted-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_1', name: 'test--echo', input: {} },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));

    const tools = new DuringCallToolModule();
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [tools],
      syncIntervalMs: 0,
    });
    const internals = framework as unknown as { deferredMessages: Array<{ forAgent?: string }> };
    // While the run's tool call is pending, a module writes with no target,
    // as its events do. The host has no primary, so the write goes to the
    // run, its one registered agent, and waits for the run's turn.
    const returned: string[] = [];
    tools.duringCall = () => {
      returned.push(tools.ctx!.addMessage('Antra', [{ type: 'text', text: 'look left' }]));
    };
    try {
      const { agent, contextManager } = await createEphemeral(framework, 'worker');
      const result = await runStartedEphemeral(framework, agent, contextManager);
      assert.strictEqual(result.speech, 'Done.');
      assert.strictEqual(returned.length, 1);
      assert.match(returned[0]!, /^held:./, "deferred: the run was waiting on its tool, so the module's context answers the held write's handle");
      assert.strictEqual(framework.getAgent(agent.name), null, 'deregistered');
      const stored = contextManager.getAllMessages().map((m) =>
        `${m.participant}: ${m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join(' ')}`);
      assert.strictEqual(stored.filter((s) => s === 'Antra: look left').length, 1,
        `stored once, in the run's namespace:\n${stored.join('\n')}`);
      assert.deepStrictEqual(internals.deferredMessages, [], 'nothing is left queued');
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('a write queued for a run that its store refuses leaves the queue at the run\'s release, logged', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-lost-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_1', name: 'test--echo', input: {} },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));

    const tools = new DuringCallToolModule();
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [tools],
      syncIntervalMs: 0,
    });
    const internals = framework as unknown as {
      addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: undefined, opts?: { forAgent?: string }): string;
      deferredMessages: Array<{ forAgent?: string }>;
      deferredWritesPersisted: boolean;
    };
    // The queue is persisted, as after a boot that restored one, so its
    // recovery file is written as it changes.
    internals.deferredWritesPersisted = true;
    tools.duringCall = () => {
      internals.addMessage('worker', [{ type: 'text', text: 'my own words' }], undefined, { forAgent: 'worker' });
      internals.addMessage('Antra', [{ type: 'text', text: 'look left' }], undefined, { forAgent: 'worker' });
    };
    const errors: string[] = [];
    const error = console.error;
    try {
      const { agent, contextManager } = await createEphemeral(framework, 'worker');
      // The run's store refuses 'look left' each time it's written.
      const add = contextManager.addMessage.bind(contextManager);
      (contextManager as unknown as { addMessage: typeof add }).addMessage = (...args) => {
        if ((args[1] as Array<{ text?: string }>).some((b) => b.text === 'look left')) throw new Error('disk full');
        return add(...args);
      };
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      const result = await runStartedEphemeral(framework, agent, contextManager);
      console.error = error;
      assert.strictEqual(result.speech, 'Done.');
      assert.strictEqual(framework.getAgent(agent.name), null, 'deregistered');
      const stored = contextManager.getAllMessages().map((m) =>
        `${m.participant}: ${m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join(' ')}`);
      assert.deepStrictEqual(stored.slice(-2), ['worker: Done.', 'worker: my own words'], 'what could be stored was');
      assert.deepStrictEqual(internals.deferredMessages.filter((m) => m.forAgent === 'worker'), [], 'nothing is left queued for the run');
      const file = JSON.parse(readFileSync(join(storePath, 'recovery', 'deferred-writes.json'), 'utf8')) as { pending: Array<{ forAgent?: string }> };
      assert.deepStrictEqual(file.pending.filter((m) => m.forAgent === 'worker'), [], 'the recovery file keeps nothing for it');
      assert.ok(errors.some((e) => e.includes('[deferred-flush] worker: failed to store a queued write before release (participant=Antra)')
        && e.includes('disk full')), errors.join('\n'));
      assert.ok(!errors.some((e) => e.includes('delivery target "worker" is not a registered agent')),
        `no later flush meets it:\n${errors.join('\n')}`);
    } finally {
      console.error = error;
      await stopAndRemove(framework, tempDir);
    }
  });

  it('resolves through the endTurn tool-result path', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-endturn-');
    const membrane = new MockMembrane();
    const tools = new EphemeralToolModule();

    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_finish', name: 'test--finish', input: {} },
    ], 'tool_use'));

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [tools],
      syncIntervalMs: 0,
    });

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const result = await runStartedEphemeral(framework, agent, contextManager);

      assert.deepStrictEqual(result, {
        speech: '',
        toolCallsCount: 1,
      });
      assert.strictEqual(tools.calls.length, 1);
      assert.strictEqual(framework.getAgent(agent.name), null);
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('rejects only after error policy exhausts retries', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-errors-');
    const membrane = new ThrowingMembrane([
      new Error('temporary failure'),
      new Error('final failure'),
    ]);

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      errorPolicy: new RetryOncePolicy(),
      syncIntervalMs: 0,
    });

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const run = runStartedEphemeral(framework, agent, contextManager);

      await assert.rejects(run, /final failure/);
      assert.strictEqual(membrane.calls.length, 2, 'the retry attempt should run before settling');
      assert.strictEqual(framework.getAgent(agent.name), null);
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('does not register a trace listener for completion control flow', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-trace-spy-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Trace independent' }]));

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      syncIntervalMs: 0,
    });

    let onTraceCalls = 0;
    const originalOnTrace = framework.onTrace.bind(framework);
    framework.onTrace = ((listener: Parameters<typeof framework.onTrace>[0]) => {
      onTraceCalls++;
      return originalOnTrace(listener);
    }) as typeof framework.onTrace;

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const result = await runStartedEphemeral(framework, agent, contextManager);

      assert.strictEqual(result.speech, 'Trace independent');
      assert.strictEqual(onTraceCalls, 0);
      assert.strictEqual(framework.getAgent(agent.name), null);
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('startup watchdog rejects and deregisters when inference never starts', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-startup-');
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      syncIntervalMs: 0,
    });

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      // Framework deliberately NOT started: the inference request is queued
      // but nothing drives it, so the (injected, short) startup watchdog is
      // the only thing that can end the run.
      const run = framework.runEphemeralToCompletion(agent, contextManager, {
        startupTimeoutMs: 1,
      });

      await assert.rejects(run, /failed to start inference/);
      assert.strictEqual(framework.getAgent(agent.name), null);
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('a context-budget restart mid-run neither rejects nor loses the tool count', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-budget-');
    // Serve exactly one queued response per stream: the budget restart opens
    // a SECOND stream, and the stock mock hands all remaining responses to
    // the first one.
    class SequentialStreamMembrane extends MockMembrane {
      private streamIdx = 0;
      streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
        this.calls.push(request);
        const stream = new MockYieldingStream(this.responses.slice(this.streamIdx, ++this.streamIdx));
        this.lastStream = stream;
        return stream;
      }
    }
    const membrane = new SequentialStreamMembrane();
    const tools = new EphemeralToolModule();

    // Stream 1: a tool round whose usage event (10 input tokens) exceeds the
    // agent's maxStreamTokens below → after the tool result lands, the
    // framework cancels the stream and queues a context_budget_restart.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Working…' },
      { type: 'tool_use', id: 'call_1', name: 'test--echo', input: { message: 'one' } },
    ], 'tool_use'));
    // Stream 2 (post-restart): the final answer.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Recovered final answer' },
    ]));

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [tools],
      syncIntervalMs: 0,
    });

    try {
      const created = await framework.createEphemeralAgent({
        name: 'worker',
        model: 'test-model',
        systemPrompt: 'Do the task.',
        allowedTools: 'all',
        maxStreamTokens: 5,
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);

      // Without the framework-cancel marker, the restart's aborted event
      // settles the run as exhausted ("Stream aborted: user") instead.
      const result = await runStartedEphemeral(framework, created.agent, created.contextManager);

      assert.deepStrictEqual(result, {
        speech: 'Recovered final answer',
        toolCallsCount: 1,
      });
      assert.strictEqual(membrane.calls.length, 2, 'restart should open a second stream');
      assert.strictEqual(framework.getAgent(created.agent.name), null);
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });
});
