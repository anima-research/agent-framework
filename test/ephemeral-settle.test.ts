import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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
import { AgentFramework } from '../src/index.js';
import { JsStore } from '@animalabs/chronicle';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

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
 *  addMessage with `forAgent`. */
class DuringCallToolModule implements Module {
  readonly name = 'test';
  duringCall: (() => void) | null = null;

  async start(_ctx: ModuleContext): Promise<void> {}
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

// For a run that stop() is to end: its turn has started inference, so if the
// refusal didn't end it, only the idle watchdog would, after fifteen minutes.
// A short one turns that into a "stalled" rejection, which the refusal's
// pattern doesn't match.
const STOPPED_RUN_WATCHDOGS = { idleTimeoutMs: 20_000, idlePollMs: 50 };

async function stopAndRemove(framework: AgentFramework, tempDir: string): Promise<void> {
  await framework.stop();
  rmSync(tempDir, { recursive: true, force: true });
}

describe('runEphemeralToCompletion settle signal', () => {
  it('a run whose turn stop() refuses ends at once, and a run asked for once stop() has begun is refused', { timeout: 60_000 }, async () => {
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

  it('a run whose turn stop() refuses before its compile ends at once', { timeout: 60_000 }, async () => {
    // The turn waits on its modules' context when stop() begins, so it is
    // refused before it compiles, not after.
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
    const framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [],
      modules: [contextModule],
      syncIntervalMs: 0,
    });
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      let compiles = 0;
      const start = agent.startStreamWithInjections.bind(agent);
      (agent as unknown as { startStreamWithInjections: typeof start }).startStreamWithInjections = async (...args) => {
        compiles++;
        return start(...args);
      };
      const run = runStartedEphemeral(framework, agent, contextManager, STOPPED_RUN_WATCHDOGS);
      await inGather;
      const stopped = framework.stop();
      release();
      await assert.rejects(run, /refused: the framework is stopping/);
      await stopped;
      assert.equal(compiles, 0, 'the turn was refused before its compile');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a run waiting to retry when stop() begins gives up before its turn starts again, and ends at once', { timeout: 60_000 }, async () => {
    // stop() ends the retry's wait, which cancels the retry before its turn
    // starts again; the run ends then, not when its idle watchdog fires.
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

  it('a run whose stream failed and waits to retry ends at once when stop() begins', { timeout: 60_000 }, async () => {
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

  it('a turn asked for once stop() has begun does not start, and its run ends at once', { timeout: 60_000 }, async () => {
    // As a wake the loop dequeued before stop() ended it would be: refused
    // before the turn starts. The run, whose request never reached the loop,
    // ends then, not when its startup watchdog fires.
    const tempDir = mkdtempSync(join(tmpdir(), 'ephemeral-late-turn-'));
    // A store the framework doesn't own stays open after stop(), as the run's
    // own cleanup needs it to.
    const store = JsStore.openOrCreate({ path: join(tempDir, 'store') });
    let gathered = 0;
    const contextModule: Module = new EphemeralToolModule();
    contextModule.gatherContext = async () => {
      gathered++;
      return [];
    };
    const framework = await AgentFramework.create({
      store,
      membrane: new MockMembrane().asMembrane(),
      agents: [],
      modules: [contextModule],
      syncIntervalMs: 0,
    });
    try {
      const { agent, contextManager } = await createEphemeral(framework);
      // Asked for, but the event loop never started, so its turn waits.
      const run = framework.runEphemeralToCompletion(agent, contextManager, STOPPED_RUN_WATCHDOGS);
      await framework.stop();
      await (framework as unknown as { startAgentStream(a: typeof agent): Promise<void> }).startAgentStream(agent);
      await assert.rejects(run, /refused: the framework is stopping/);
      assert.equal(gathered, 0, 'the turn did not start');
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
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
    const returned: string[] = [];
    tools.duringCall = () => {
      returned.push(internals.addMessage('worker', [{ type: 'text', text: 'my own words' }], undefined, { forAgent: 'worker' }));
      returned.push(internals.addMessage('Antra', [{ type: 'text', text: 'look left' }], undefined, { forAgent: 'worker' }));
    };

    try {
      const { agent, contextManager } = await createEphemeral(framework, 'worker');
      const result = await runStartedEphemeral(framework, agent, contextManager);
      assert.strictEqual(result.speech, 'Done.');
      assert.deepStrictEqual(returned, ['', ''], 'both were deferred: the run was waiting on its tool');
      assert.strictEqual(framework.getAgent(agent.name), null, 'deregistered');
      const stored = contextManager.getAllMessages().map((m) =>
        `${m.participant}: ${m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join(' ')}`);
      assert.deepStrictEqual(stored.slice(-3), ['worker: Done.', 'worker: my own words', 'Antra: look left'],
        'held to the turn end, and stored after the run\'s last reply');
    } finally {
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
        startupTimeoutMs: 50,
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

describe('trace control-flow guard', () => {
  it('does not use this.onTrace inside src control flow', () => {
    const root = process.cwd();
    const srcRoot = join(root, 'src');
    // Structural allowance, not an exact source line (which breaks on any
    // reformat and turns the guard into a boy-who-cried-wolf): re-EXPOSING
    // the subscription API — forwarding a caller-supplied listener, as the
    // ModuleContext plumbing does — is fine. What the guard forbids is the
    // framework subscribing its OWN listener to drive control flow.
    const isSubscriptionPlumbing = (line: string) =>
      /onTrace:\s*\([^)]*\)\s*=>\s*this\.onTrace\(/.test(line);
    const matches: string[] = [];

    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(path);
          continue;
        }
        if (!entry.isFile() || !path.endsWith('.ts')) continue;

        const rel = relative(root, path);
        const lines = readFileSync(path, 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (!line.includes('this.onTrace(')) return;
          if (isSubscriptionPlumbing(line)) return;
          matches.push(`${rel}:${index + 1}: ${line.trim()}`);
        });
      }
    };

    visit(srcRoot);
    assert.deepStrictEqual(matches, []);
  });
});
