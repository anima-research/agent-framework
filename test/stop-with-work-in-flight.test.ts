/**
 * stop() with work still in flight.
 *
 * stop() closes the process queue first and closes MCPL connections later,
 * so for a while work started before stop() keeps completing, and servers
 * keep sending. Two outcomes, one boundary (found through #256's aborted-
 * stream test, where a robot--move outlived the framework; the race itself
 * is older than #256):
 *   - a tool's result that arrives after stop() is logged and dropped: the
 *     queue that would carry it to its stream is closed, stop() is ending
 *     the streams, and the tool has already run. Before, its
 *     push threw "Queue is closed", the throw was misreported as the tool's
 *     failure, and that failure's push threw again, unhandled;
 *   - a server's push, incoming message or other request the host can't
 *     take any more is answered with a JSON-RPC error (-32000, "the host is
 *     stopping"), never "accepted", and never thrown out of the
 *     connection's listener; a handler's own fault is answered -32603.
 * Any other event pushed to a stopped framework still throws to its caller.
 * A turn waiting to retry is work in flight too: stop() cancels the retry,
 * and leaves no agent inferring at the event gate, which a start() after the
 * stop goes on with (#334). The turn ends with inference:aborted, saying no
 * retry follows its inference:failed, whether its stream failed to start or
 * failed once started. A turn that continues after that start() is marked
 * inferring again.
 * Each test waits on the event it needs (a log line, an answer), not on a
 * fixed delay, and then one more turn, so a late rejection would be seen.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import type {
  ErrorAction,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { HeldStream, MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

/** Resolve once `cond` holds, polling each turn; fail, naming `what`, after `ms`. */
async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

/** One more turn of the event loop: an unhandled rejection is reported by then. */
const turn = (): Promise<void> => new Promise((r) => setImmediate(() => setImmediate(r)));

/**
 * The tool-result scan: in each source, every object literal whose `type`
 * property is the string 'tool-result', read as a syntax tree (Babel's
 * TypeScript parser) rather than as text, wherever the literal sits.
 * - A property is read when it's written `key: value` or as a shorthand.
 *   Its key is an identifier, or a string in any quoting, computed or not; a
 *   computed key that isn't a string, a getter or a method, and a spread
 *   aren't read.
 * - A value is read through `as`, `satisfies`, `<T>`, `!` and parentheses,
 *   and a string in any quoting, escapes included. A string built at run
 *   time, by a template with substitutions or by `+`, or held in a const,
 *   isn't read.
 * Each literal must carry toolName. Where its callId reads a call's `id`
 * and its toolName that call's `name`, as `X.id`, `X?.id` or `X['id']`
 * through the same wrappers, they must read the same X, compared as source
 * text. Any other callId or toolName (a string, a variable, a fallback with
 * `??`) isn't compared.
 */
function scanToolResults(sources: Array<{ name: string; text: string }>): {
  literals: string[];
  paired: number;
  missing: string[];
  mismatched: string[];
} {
  // Babel's nodes, read structurally: each has a `type`, its children are
  // its node-valued fields, and its source span is `start`..`end`.
  type Node = { type: string; start?: number | null; end?: number | null; loc?: { start: { line: number } } | null; [field: string]: unknown };
  const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';
  const child = (n: Node | undefined, field: string): Node | undefined => (n && isNode(n[field]) ? n[field] as Node : undefined);
  const unwrap = (e: Node | undefined): Node | undefined => {
    while (e && ['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression'].includes(e.type)) {
      e = child(e, 'expression');
    }
    return e;
  };
  // A string's text, in any quoting: '…', "…" or a template with no substitutions.
  const stringOf = (e: Node | undefined): string | undefined => {
    e = unwrap(e);
    if (e?.type === 'StringLiteral') return e.value as string;
    if (e?.type === 'TemplateLiteral' && (e.expressions as unknown[]).length === 0) {
      return ((e.quasis as Node[])[0].value as { cooked?: string }).cooked;
    }
    return undefined;
  };
  // A property's name, however its key is written; a computed key that isn't a string has none.
  const nameOf = (p: Node): string | undefined => {
    const key = child(p, 'key');
    return !p.computed && key?.type === 'Identifier' ? key.name as string : stringOf(key);
  };
  const literals: string[] = [];
  const missing: string[] = [];
  const mismatched: string[] = [];
  let paired = 0;
  for (const { name, text } of sources) {
    let program: Node;
    try {
      // Babel keeps no node for parentheses, so `(x)` reads as `x`.
      program = parse(text, { sourceType: 'module', plugins: ['typescript'] }).program as unknown as Node;
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    }
    // The call an `X.id` or `X.name` reads, as X's source text (`call`, `tc`).
    const callRead = (p: Node | undefined, field: 'id' | 'name'): string | undefined => {
      const e = unwrap(child(p, 'value'));
      if (e?.type !== 'MemberExpression' && e?.type !== 'OptionalMemberExpression') return undefined;
      const property = child(e, 'property');
      const read = e.computed ? stringOf(property) : property?.type === 'Identifier' ? property.name as string : undefined;
      const object = unwrap(child(e, 'object'));
      return read === field && object ? text.slice(object.start!, object.end!) : undefined;
    };
    const visit = (node: Node): void => {
      if (node.type === 'ObjectExpression') {
        const properties = (node.properties as Node[]).filter((p) => p.type === 'ObjectProperty');
        const type = properties.find((p) => nameOf(p) === 'type');
        if (type && stringOf(child(type, 'value')) === 'tool-result') {
          const where = `${name}:${node.loc!.start.line}`;
          literals.push(where);
          const property = (field: string) => properties.find((p) => nameOf(p) === field);
          const toolName = property('toolName');
          if (!toolName) missing.push(where);
          const idOf = callRead(property('callId'), 'id');
          const nameFrom = callRead(toolName, 'name');
          if (idOf !== undefined && nameFrom !== undefined) {
            paired++;
            if (idOf !== nameFrom) mismatched.push(`${where}: callId reads ${idOf}, toolName reads ${nameFrom}`);
          }
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) { for (const v of value) if (isNode(v)) visit(v); }
        else if (isNode(value)) visit(value);
      }
    };
    visit(program);
  }
  return { literals, paired, missing, mismatched };
}

/** A tool that settles only when the test says so, so the test owns the work it started. */
class SlowModule implements Module {
  readonly name = 'slow';
  private settle: { resolve: (r: ToolResult) => void; reject: (e: Error) => void } | null = null;
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise((r) => { this.markStarted = r; });
  }

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{ name: 'work', description: 'Slow work', inputSchema: { type: 'object', properties: {} } }];
  }

  handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
      this.markStarted();
    });
  }

  /**
   * Settle the running call. The caller waits for what it expects to follow
   * (the drop's log line); this returns at once.
   * - success: { success: true }
   * - failure: the module throws (the registry answers an error result)
   * - isError: { success: true, isError: true }, a result that reports an error
   * - bare-failure: { success: false } with no error text
   * - long-failure: the module throws a 5,000-character error
   */
  finish(outcome: 'success' | 'failure' | 'isError' | 'bare-failure' | 'long-failure'): void {
    if (outcome === 'success') this.settle!.resolve({ success: true, data: { done: true } });
    else if (outcome === 'isError') this.settle!.resolve({ success: true, isError: true, data: { done: false } });
    else if (outcome === 'bare-failure') this.settle!.resolve({ success: false });
    else if (outcome === 'long-failure') this.settle!.reject(new Error('x'.repeat(5000)));
    else this.settle!.reject(new Error('the work failed'));
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: [{ type: 'text', text: String((event as { content?: unknown }).content) }] }],
        requestInference: true,
      };
    }
    return {};
  }
}

describe('stop() with work still in flight', () => {
  let tempDir: string;
  let rejections: unknown[];
  let logged: string[];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  const consoleError = console.error;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'af-stop-in-flight-'));
    rejections = [];
    logged = [];
    process.on('unhandledRejection', onRejection);
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  });

  afterEach(() => {
    console.error = consoleError;
    process.off('unhandledRejection', onRejection);
    rmSync(tempDir, { recursive: true, force: true });
  });

  const dropped = (): string[] => logged.filter((line) => line.includes('arrived after stop'));

  async function frameworkWithRunningTool(
    opts: { dispatch?: 'rejects' } = {},
  ): Promise<{ framework: AgentFramework; module: SlowModule; failed: string[] }> {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Working on it.' },
      { type: 'tool_use', id: 'c1', name: 'slow--work', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Never written.' }] as ContentBlock[]));
    const module = new SlowModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
      modules: [module],
    });
    const failed: string[] = [];
    framework.onTrace((e) => {
      if (e.type === 'tool:failed') failed.push(String((e as { tool?: unknown }).tool));
    });
    if (opts.dispatch === 'rejects') {
      // The module registry turns a module's throw into an error result; this
      // is the dispatch itself rejecting (the host got no result at all).
      const registry = (framework as unknown as { moduleRegistry: { handleToolCall(call: ToolCall): Promise<ToolResult> } }).moduleRegistry;
      const handle = registry.handleToolCall.bind(registry);
      registry.handleToolCall = (call) => handle(call).then(() => { throw new Error('the dispatch was lost'); });
    }
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
    await module.started;
    return { framework, module, failed };
  }

  /** Wait for the drop's log line, then a turn, so a late rejection would be seen. */
  async function droppedLine(): Promise<string> {
    await until(() => dropped().length > 0, 'the drop log line');
    await turn();
    assert.equal(dropped().length, 1, logged.join('\n'));
    return dropped()[0]!;
  }

  it('a tool that succeeds after stop() has its result dropped, not thrown or misreported as a failure', async () => {
    const { framework, module, failed } = await frameworkWithRunningTool();
    await framework.stop();
    module.finish('success');
    const line = await droppedLine();

    assert.deepEqual(rejections, []);
    assert.deepEqual(failed, [], 'the tool succeeded; nothing reports it as a failure');
    // The drop names the tool and that it succeeded: what an operator needs
    // to reconcile a result nothing could take.
    assert.match(line, /tool call c1 \(slow--work, slow\)/, line);
    assert.match(line, /the tool succeeded$/, line);
  });

  it('a tool that fails after stop() has its error result dropped, not thrown', async () => {
    const { framework, module, failed } = await frameworkWithRunningTool();
    await framework.stop();
    module.finish('failure');
    const line = await droppedLine();

    assert.deepEqual(rejections, []);
    assert.deepEqual(failed, [], 'the registry answers a module throw with an error result');
    assert.match(line, /the tool failed: /, line);
  });

  it("a tool's long error is bounded in the drop's log line", async () => {
    const { framework, module } = await frameworkWithRunningTool();
    await framework.stop();
    module.finish('long-failure');
    const line = await droppedLine();

    assert.ok(line.length < 800, `logged ${line.length} characters`);
    assert.match(line, /the tool failed: x+… \(5000 characters\)$/, line);
    assert.deepEqual(rejections, []);
  });

  it('a result that reports an error is dropped as failed, and a failure with no text says only that', async () => {
    // { success: true, isError: true } is a failure: the drop must not call it a success.
    {
      const { framework, module } = await frameworkWithRunningTool();
      await framework.stop();
      module.finish('isError');
      const line = await droppedLine();
      assert.match(line, /the tool failed$/, line);
      logged.length = 0;
    }
    {
      const { framework, module } = await frameworkWithRunningTool();
      await framework.stop();
      module.finish('bare-failure');
      const line = await droppedLine();
      assert.match(line, /the tool failed$/, line);
    }
    assert.deepEqual(rejections, []);
  });

  it('a dispatch that rejects after stop() is reported as failed, and its failure result dropped, not thrown', async () => {
    const { framework, module, failed } = await frameworkWithRunningTool({ dispatch: 'rejects' });
    await framework.stop();
    module.finish('success');
    const line = await droppedLine();

    assert.deepEqual(rejections, []);
    assert.equal(failed.length, 1, 'the host got no result: a dispatch failure');
    assert.match(line, /tool call c1 \(slow--work, slow\)/, line);
    assert.match(line, /the tool failed: .*the dispatch was lost/, line);
  });

  it('any other event pushed to a stopped framework still throws to its caller', async () => {
    const { framework, module } = await frameworkWithRunningTool();
    await framework.stop();
    assert.throws(
      () => framework.pushEvent({ type: 'external-message', source: 'test', content: 'too late', metadata: {} } as unknown as ProcessEvent),
      /Queue is closed/,
    );
    module.finish('success');
    await droppedLine();
    assert.deepEqual(rejections, []);
  });

  /** A resident whose retry waits longer than the test, so only stop() ends
   *  the wait, which cancels the retry; `stream` is its one stream. */
  async function frameworkWaitingToRetry(stream: () => MockYieldingStream): Promise<{
    framework: AgentFramework; membrane: MockMembrane; inDelay: Promise<void>; turnEvents: Array<{ type: string; reason?: string }>;
  }> {
    let waiting!: () => void;
    const inDelay = new Promise<void>((resolve) => { waiting = resolve; });
    const membrane = new MockMembrane();
    membrane.streamYielding = (request) => {
      membrane.calls.push(request);
      return stream();
    };
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
      modules: [new SlowModule()],
      gate: { config: { policies: [], default: 'always' } },
      errorPolicy: {
        maxRetries: 1,
        onInferenceError: (_error: Error, _agent: string, attempt: number): ErrorAction => {
          waiting();
          return attempt < 1 ? { retry: true, delayMs: 60_000 } : { retry: false };
        },
      },
    });
    // What a listener that brackets the turn sees, such as a typing loop.
    const turnEvents: Array<{ type: string; reason?: string }> = [];
    framework.onTrace((event) => {
      const traced = event as { type: string; agentName?: string; reason?: string };
      if (traced.agentName === 'assistant' && /^inference:(started|completed|failed|aborted|exhausted)$/.test(traced.type)) {
        turnEvents.push({ type: traced.type, ...(traced.reason !== undefined ? { reason: traced.reason } : {}) });
      }
    });
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
    return { framework, membrane, inDelay, turnEvents };
  }

  /** The turn's record on /healthz, which ends when the turn does. */
  function lastInference(framework: AgentFramework): { startedAt?: number; endedAt?: number } | null | undefined {
    const snapshot = framework.healthSnapshot() as {
      agents: Array<{ name: string; lastInference: { startedAt?: number; endedAt?: number } | null }>;
    };
    return snapshot.agents.find((agent) => agent.name === 'assistant')?.lastInference;
  }

  const RETRY_CANCELLED = 'a retry waiting while the framework was stopping is dropped before it sends anything';

  /** A stream that fails once it has started, so driveStream waits to retry. */
  function failingOnceStarted(): MockYieldingStream {
    const stream = new MockYieldingStream([]);
    (stream as unknown as { events: unknown[] }).events.push({ type: 'error', error: new Error('overloaded') });
    return stream;
  }

  it('a turn whose retry stop() cancels leaves no agent inferring at the event gate, and ends saying why', { timeout: 60_000 }, async () => {
    // The stream can't start. While an agent is inferring at the gate, the
    // gate buffers every batch it debounces instead of delivering it, and
    // wakes no agent for it.
    const { framework, membrane, inDelay, turnEvents } = await frameworkWaitingToRetry(() => {
      throw new Error('the stream could not start');
    });
    const gate = (framework as unknown as { eventGate: { inferenceDiagnostics(): { inferring: string[] } } }).eventGate;
    await inDelay;
    assert.deepEqual(gate.inferenceDiagnostics().inferring, ['assistant'], 'the turn is open at the gate while its retry waits');
    await framework.stop();
    assert.deepEqual(gate.inferenceDiagnostics().inferring, [], 'stop() leaves no agent inferring');
    assert.equal(membrane.calls.length, 1, 'the retry was cancelled, not sent');
    // The attempt's inference:failed is usually followed by its retry: the
    // turn ends with an event saying none follows, and its record ends.
    assert.deepEqual(turnEvents, [
      { type: 'inference:started' }, { type: 'inference:failed' }, { type: 'inference:aborted', reason: RETRY_CANCELLED },
    ]);
    const last = lastInference(framework);
    assert.ok(last?.endedAt !== undefined && last.endedAt >= (last.startedAt ?? Infinity), JSON.stringify(last));
    assert.deepEqual(rejections, []);
  });

  it('a turn whose stream failed once started, and whose retry stop() cancels, ends saying why', { timeout: 60_000 }, async () => {
    // The same cancelled retry, waited for by the stream's own frame.
    const { framework, membrane, inDelay, turnEvents } = await frameworkWaitingToRetry(failingOnceStarted);
    await inDelay;
    await framework.stop();
    assert.equal(membrane.calls.length, 1, 'the retry was cancelled, not sent');
    assert.deepEqual(turnEvents, [
      { type: 'inference:started' }, { type: 'inference:failed' }, { type: 'inference:aborted', reason: RETRY_CANCELLED },
    ]);
    const last = lastInference(framework);
    assert.ok(last?.endedAt !== undefined && last.endedAt >= (last.startedAt ?? Infinity), JSON.stringify(last));
    assert.deepEqual(rejections, []);
  });

  it("a stream's cancelled retry says nothing when another turn of its agent's name holds the turn", { timeout: 60_000 }, async () => {
    // The events carry only the name, so this frame's end would end that
    // newer turn's bracket instead, as abortDroppedTurn's drops avoid too.
    const { framework, inDelay, turnEvents } = await frameworkWaitingToRetry(failingOnceStarted);
    await inDelay;
    (framework as unknown as { activeTurnTokens: Map<string, number> }).activeTurnTokens.set('assistant', -1);
    await framework.stop();
    assert.deepEqual(turnEvents, [{ type: 'inference:started' }, { type: 'inference:failed' }]);
    assert.deepEqual(rejections, []);
  });

  it('a budget restart taken up after a stop() and a start() marks its agent inferring again', { timeout: 60_000 }, async () => {
    // A restart left queued when stop() ends the loop continues its turn once
    // a start() on the same framework takes it up. stop() cleared the gate's
    // entries, and a turn that continues another doesn't start a new one, so
    // it has to take its agent's again: while no agent is inferring, the gate
    // delivers debounced batches, and residents share one message slot.
    const store = JsStore.openOrCreate({ path: join(tempDir, 'store') });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let streaming!: () => void;
    const inStream = new Promise<void>((resolve) => { streaming = resolve; });
    const membrane = new MockMembrane();
    membrane.streamYielding = (request) => {
      membrane.calls.push(request);
      streaming();
      return new HeldStream(released, [createMockResponse([{ type: 'text', text: 'continued' }] as ContentBlock[])]);
    };
    const framework = await AgentFramework.create({
      store,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
      modules: [new SlowModule()],
      gate: { configPath: join(tempDir, 'gate.json'), config: { policies: [], default: 'always' } },
    });
    const internal = framework as unknown as {
      eventGate: { inferenceDiagnostics(): { inferring: string[] } };
      pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
    };
    try {
      framework.start();
      await framework.stop();
      // Queued while the framework is stopped, as a restart that stop() left
      // queued is: the next start()'s loop takes it up.
      internal.pendingRequests.push({ agentName: 'assistant', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() });
      framework.start();
      await inStream;
      assert.deepEqual(internal.eventGate.inferenceDiagnostics().inferring, ['assistant'], 'the continuing turn holds its entry');
      release();
      await until(() => internal.eventGate.inferenceDiagnostics().inferring.length === 0, 'the turn to end');
      assert.equal(membrane.calls.length, 1);
      assert.deepEqual(rejections, []);
    } finally {
      release();
      await framework.stop();
      store.close();
    }
  });

  describe("tune-out's subconscious tools", () => {
    /** A framework whose tune-out coordinator is a stand-in that settles when the test says. */
    async function withTuneOut() {
      const framework = await AgentFramework.create({
        storePath: join(tempDir, 'store'),
        membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
        modules: [],
      });
      let settle!: { resolve: (r: ToolResult) => void; reject: (e: unknown) => void };
      const fw = framework as unknown as {
        tuneOutCoordinator: unknown; subconsciousAgentName: string | null;
        dispatchToolCall(agentName: string, call: ToolCall): void;
      };
      fw.tuneOutCoordinator = {
        handleSubconsciousTool: () => new Promise<ToolResult>((resolve, reject) => { settle = { resolve, reject }; }),
        stop: () => {},
      };
      fw.subconsciousAgentName = 'assistant';
      const pushed: ProcessEvent[] = [];
      const push = framework.pushEvent.bind(framework);
      framework.pushEvent = (event: ProcessEvent) => { pushed.push(event); push(event); };
      fw.dispatchToolCall('assistant', { id: 't1', name: 'deliver_summary', input: {} } as ToolCall);
      return { framework, settle: () => settle, pushed };
    }

    it('a result that arrives after stop() is dropped and logged with its tool, not thrown', async () => {
      const { framework, settle } = await withTuneOut();
      await framework.stop();
      settle().resolve({ success: true, data: { delivered: true } });
      const line = await droppedLine();
      assert.match(line, /tool call t1 \(deliver_summary, tune-out\)/, line);
      assert.match(line, /the tool succeeded$/, line);
      assert.deepEqual(rejections, []);
    });

    it('a handler that rejects is answered with a failed result, never left unhandled', async () => {
      const { framework, settle, pushed } = await withTuneOut();
      try {
        settle().reject(new Error('the summary failed'));
        await until(() => pushed.length > 0, 'the failed result');
        await turn();
        const result = (pushed[0] as unknown as { result: ToolResult }).result;
        assert.deepEqual(result, { success: false, error: 'the summary failed', isError: true });
        assert.deepEqual(rejections, []);
      } finally {
        await framework.stop();
      }
    });
  });

  it('every tool result the framework produces names its tool, and the call it answers', () => {
    // The drop's log line names the tool from the event's toolName, so a
    // producer that leaves it out logs a drop nobody can reconcile, and one
    // that names another call's tool misleads whoever reconciles it. Every
    // tool-result object literal in src carries toolName, and where its
    // callId and toolName both read a call, they read the same one
    // (scanToolResults, which the next test checks).
    const src = fileURLToPath(new URL('../../src/', import.meta.url));
    const sources: Array<{ name: string; text: string }> = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts')) sources.push({ name: full.slice(src.length), text: readFileSync(full, 'utf8') });
      }
    };
    walk(src);
    assert.ok(sources.some((s) => s.name.includes('/')), 'the walk reaches src\'s subdirectories');
    const { literals, paired, missing, mismatched } = scanToolResults(sources);
    assert.ok(literals.length > 20, `found ${literals.length} tool-result literals; the scan has lost them`);
    assert.deepEqual(missing, [], 'tool-result events without toolName');
    assert.ok(paired > 20, `paired ${paired} callId/toolName reads; the pairing has lost them`);
    assert.deepEqual(mismatched, [], "tool-result events naming another call's tool");
  });

  it('the tool-result scan reads every way the literal can be written, and reports what it should', () => {
    const a = [
      'declare const call: { id: string; name: string };',
      'declare const other: { id: string; name: string };',
      'declare const maybe: { id: string; name: string } | undefined;',
      'export const events = [',
      "  { type: 'tool-result', callId: call.id, toolName: call.name },",
      '  { type: "tool-result", callId: call.id, toolName: call.name },',
      '  { type: `tool-result`, callId: call.id, toolName: call.name },',
      "  { type: 'tool\\x2dresult', callId: call.id, toolName: call.name },",
      "  { 'type': 'tool-result' as const, callId: call.id, toolName: call.name },",
      "  { type: ('tool-result') satisfies string, callId: call.id, toolName: call.name },",
      "  { ['type']: <const>'tool-result', callId: call.id, toolName: call.name },",
      "  { type: 'tool-result'!, callId: (call as typeof call).id as string, toolName: call!.name! },",
      "  { type: 'tool-result', callId: maybe?.id, toolName: maybe?.name },",
      "  { type: 'tool-result', callId: call['id'], toolName: call[`name`] },",
      "  { type: 'tool-result', callId: ev.call.id, toolName: ev.call.name },",
      "  { type: 'tool-result', callId: call.id },",
      "  { type: 'tool-result', callId: call.id, toolName: other.name },",
      "  { type: 'tool-result', callId: (call).id, toolName: (other as typeof other).name },",
      "  { type: 'tool-result', callId: 'c1', toolName: 'read' },",
      "  { type: 'tool-result', callId: call.id, toolName: call.id },",
      "  { type: 'tool-result', callId: call[id], toolName: call.name },",
      "  { type: 'tool-result', callId: call.id, toolName: other.name ?? 'read' },",
      "  { type: 'tool-result', callId: call.id, [toolName]: call.name },",
      "  { type: 'tool-result', callId: call.id, get toolName() { return call.name; } },",
      "  { ...base, type: 'tool-result', callId: call.id },",
      "  { [type]: 'tool-result', callId: call.id },",
      '  { type: `tool-result${suffix}`, callId: call.id },',
      "  { type: 'tool-results', callId: call.id },",
      "  { kind: 'tool-result', callId: call.id },",
      '];',
    ].join('\n');
    const b = [
      'export function emit(wrap: (e: unknown) => void, call: { id: string; name: string }) {',
      "  wrap({ inner: { type: 'tool-result', callId: call.id, toolName: call.name } });",
      "  wrap({ type: 'tool-result', callId: call.id });",
      '}',
    ].join('\n');
    const result = scanToolResults([{ name: 'a.ts', text: a }, { name: 'b.ts', text: b }]);
    const at = (name: string, ...ns: number[]) => ns.map((n) => `${name}:${n}`);
    assert.deepEqual(result.literals, [...at('a.ts', 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25), ...at('b.ts', 2, 3)],
      'each spelling of the literal, wherever it sits, and nothing else');
    // A computed variable key, a getter and a spread aren't read, so their toolName is missing.
    assert.deepEqual(result.missing, [...at('a.ts', 16, 23, 24, 25), ...at('b.ts', 3)]);
    // Through wrappers, optional and computed string members, and a member chain;
    // not a wrong field, a variable index, a string or a fallback.
    assert.equal(result.paired, 14, 'the call reads paired');
    assert.deepEqual(result.mismatched, [
      'a.ts:17: callId reads call, toolName reads other',
      'a.ts:18: callId reads call, toolName reads other',
    ]);
    // A source Babel can't parse fails the scan by name.
    assert.throws(() => scanToolResults([{ name: 'broken.ts', text: 'const = ;' }]), /^Error: broken\.ts: /);
  });

  describe('a server sending while the host stops', () => {
    async function wiredFramework() {
      const framework = await AgentFramework.create({
        storePath: join(tempDir, 'store'),
        membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
        modules: [],
      });
      const connection = Object.assign(new EventEmitter(), { id: 'srv' });
      (framework as unknown as { wireMcplEvents(c: unknown): void }).wireMcplEvents(connection);
      return { framework, connection };
    }

    /**
     * Put a stand-in in for every request listener's handler, each calling
     * `handler` with what it was given: the push handler, the channel
     * registry's three, the inference router and the host-command handler.
     */
    function standIns(framework: AgentFramework, handler: (...args: never[]) => Promise<unknown>): void {
      const fw = framework as unknown as {
        pushHandler: unknown; channelRegistry: unknown; inferenceRouter: unknown; handleHostCommand: unknown;
      };
      fw.pushHandler = { handlePushEvent: handler };
      fw.channelRegistry = { handleIncoming: handler, handleRegister: handler, handleChanged: handler, stopAll: () => {} };
      fw.inferenceRouter = { handleInferenceRequest: handler };
      fw.handleHostCommand = handler;
    }

    /** Every request listener: its event, its method, and parameters it takes. */
    const requests = [
      ['push-event', 'push/event', { featureSet: 'chat', eventId: 'e20', payload: { content: [{ type: 'text', text: 'x' }] } }],
      ['channels-incoming', 'channels/incoming', { messages: [{ channelId: 'c', messageId: 'm20', content: [] }] }],
      ['channels-register', 'channels/register', { channels: [] }],
      ['channels-changed', 'channels/changed', { added: [] }],
      ['inference-request', 'inference/request', { messages: [] }],
      ['host-command', 'host/command', { command: 'undo' }],
    ] as const;

    /**
     * A server's responder, recording each answer.
     * - throws: respondError records its answer, then throws (the connection is going).
     * - serializes: respond serializes the result before it records it, as the
     *   connection's sendResponse does, so a result JSON can't hold throws.
     */
    function responder(opts: { throws?: boolean; serializes?: boolean } = {}) {
      const answers: Array<{ result?: unknown; error?: { code: number; message: string } }> = [];
      return {
        id: 7,
        answers,
        respond: (result: unknown) => {
          if (opts.serializes) JSON.stringify(result);
          answers.push({ result });
        },
        respondError: (code: number, message: string) => {
          answers.push({ error: { code, message } });
          if (opts.throws) throw new Error('the connection is gone');
        },
      };
    }

    /** Wait until each responder has its answer, then a turn. */
    async function answered(...rs: Array<{ answers: unknown[] }>): Promise<void> {
      await until(() => rs.every((r) => r.answers.length > 0), 'every answer');
      await turn();
    }

    const stopping = { error: { code: -32000, message: 'the host is stopping' } };

    it('a push, incoming message or other request after stop() is answered -32000, never handled or accepted', async () => {
      const { framework, connection } = await wiredFramework();
      await framework.stop();
      // Stand-in handlers, put in after stop() (which stops the real registry): every arrival below comes later.
      let handled = 0;
      standIns(framework, async () => { handled++; return {}; });

      const push = responder();
      connection.emit('push-event', { featureSet: 'chat', eventId: 'e1', payload: { content: [{ type: 'text', text: 'late' }] } }, push);
      const incoming = responder();
      connection.emit('channels-incoming', { messages: [{ channelId: 'c', messageId: 'm', content: [] }] }, incoming);
      const register = responder();
      connection.emit('channels-register', { channels: [] }, register);
      const changed = responder();
      connection.emit('channels-changed', { added: [] }, changed);
      const inference = responder();
      connection.emit('inference-request', { messages: [] }, inference);
      const command = responder();
      connection.emit('host-command', { command: 'undo' }, command);
      await answered(push, incoming, register, changed, inference, command);

      assert.equal(handled, 0, 'never handed to a handler, which would record it as accepted or act on it');
      for (const r of [push, incoming, register, changed, inference, command]) assert.deepEqual(r.answers, [stopping]);
      assert.deepEqual(rejections, []);
    });

    for (const [event, method, params] of [
      ['push-event', 'push/event', { featureSet: 'chat', eventId: 'e2', payload: { content: [{ type: 'text', text: 'waiting' }] } }],
      ['channels-incoming', 'channels/incoming', { messages: [{ channelId: 'c', messageId: 'm2', content: [] }] }],
      ['inference-request', 'inference/request', { messages: [] }],
      ['host-command', 'host/command', { command: 'undo' }],
    ] as const) {
      it(`a ${method} held at the awareness barrier while the host stops is refused once the barrier lifts`, async () => {
        const { framework, connection } = await wiredFramework();
        let lift!: () => void;
        (framework as unknown as { discordAwarenessBarrier: unknown }).discordAwarenessBarrier = {
          promise: new Promise<void>((r) => { lift = r; }),
        };
        let handled = 0;
        standIns(framework, async () => { handled++; return {}; });

        const r = responder();
        connection.emit(event, params, r);
        await framework.stop();
        lift();
        await answered(r);

        assert.equal(handled, 0);
        assert.deepEqual(r.answers, [stopping]);
        assert.ok(logged.some((line) => line.includes(`${method} from srv refused: the host is stopping`)), logged.join('\n'));
        assert.deepEqual(rejections, []);
      });
    }

    it('a handler running when the host stops, and then failing, is answered -32000 with its own message', async () => {
      const { framework, connection } = await wiredFramework();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      (framework as unknown as { pushHandler: unknown }).pushHandler = {
        handlePushEvent: async () => { await gate; throw new Error('Queue is closed'); },
      };

      const push = responder();
      connection.emit('push-event', { featureSet: 'chat', eventId: 'e6', payload: { content: [{ type: 'text', text: 'x' }] } }, push);
      await framework.stop();
      release();
      await answered(push);

      const reason = 'the host stopped while handling this request (Queue is closed)';
      assert.deepEqual(push.answers, [{ error: { code: -32000, message: reason } }]);
      assert.ok(logged.some((line) => line.includes(`push/event from srv failed: ${reason} (part of it may already have been admitted)`)), logged.join('\n'));
      assert.deepEqual(rejections, []);
    });

    it('a handler that throws is answered -32603 with its error, not rejected into the listener; a notification is only logged', async () => {
      const { framework, connection } = await wiredFramework();
      try {
        (framework as unknown as { pushHandler: unknown }).pushHandler = {
          handlePushEvent: async (_s: string, params: { eventId: string }) => { throw new Error(`the handler broke on ${params.eventId}`); },
        };

        const push = responder();
        connection.emit('push-event', { featureSet: 'chat', eventId: 'e3', payload: { content: [{ type: 'text', text: 'x' }] } }, push);
        connection.emit('push-event', { featureSet: 'chat', eventId: 'e4', payload: { content: [{ type: 'text', text: 'y' }] } });
        await answered(push);
        await until(() => logged.some((line) => line.includes('the handler broke on e4')), "the notification's log line");

        assert.deepEqual(push.answers, [{ error: { code: -32603, message: 'the handler broke on e3' } }]);
        assert.ok(logged.some((line) => line.includes('push/event from srv failed: the handler broke on e4 (part of it may already have been admitted)')), logged.join('\n'));
        assert.deepEqual(rejections, []);
      } finally {
        await framework.stop();
      }
    });

    it('a handler that rejects with nothing, a string or an unprintable value is a failed request, not a stopping refusal', async () => {
      const { framework, connection } = await wiredFramework();
      try {
        const fw = framework as unknown as { pushHandler: unknown; channelRegistry: unknown };
        // A revoked Proxy throws on instanceof itself; an Error whose message is a number has no slice.
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        const numbered = new Error('placeholder');
        Object.defineProperty(numbered, 'message', { value: 42 });
        // An Error whose message getter throws: reading it is itself guarded.
        const unreadable = new Error('placeholder');
        Object.defineProperty(unreadable, 'message', { get() { throw new Error('the message getter broke'); } });
        const thrown: Record<string, unknown> = {
          e5: undefined, e7: 'a plain string', e8: Object.create(null), e12: revoked.proxy, e13: numbered, e14: unreadable,
        };
        fw.pushHandler = {
          // eslint-disable-next-line prefer-promise-reject-errors
          handlePushEvent: (_s: string, params: { eventId: string }) => Promise.reject(thrown[params.eventId]),
        };
        fw.channelRegistry = { handleIncoming: async () => { throw undefined; }, stopAll: () => {} };

        const answersFor = (eventId: string) => {
          const r = responder();
          connection.emit('push-event', { featureSet: 'chat', eventId, payload: { content: [{ type: 'text', text: 'x' }] } }, r);
          return r;
        };
        const e5 = answersFor('e5');
        const e7 = answersFor('e7');
        const e8 = answersFor('e8');
        const e12 = answersFor('e12');
        const e13 = answersFor('e13');
        const e14 = answersFor('e14');
        const incoming = responder();
        connection.emit('channels-incoming', { messages: [{ channelId: 'c', messageId: 'm', content: [] }] }, incoming);
        await answered(e5, e7, e8, e12, e13, e14, incoming);

        assert.deepEqual(e5.answers, [{ error: { code: -32603, message: 'the handler failed' } }]);
        assert.deepEqual(e7.answers, [{ error: { code: -32603, message: 'the handler failed: a plain string' } }]);
        assert.deepEqual(e8.answers, [{ error: { code: -32603, message: 'the handler failed: (a value that could not be read)' } }]);
        assert.deepEqual(e12.answers, [{ error: { code: -32603, message: 'the handler failed: (a value that could not be read)' } }]);
        assert.deepEqual(e13.answers, [{ error: { code: -32603, message: '42' } }]);
        assert.deepEqual(e14.answers, [{ error: { code: -32603, message: '(a value that could not be read)' } }]);
        assert.deepEqual(incoming.answers, [{ error: { code: -32603, message: 'the handler failed' } }]);
        assert.ok(!logged.some((line) => line.includes('refused')), 'a live host refuses nothing');
        assert.deepEqual(rejections, []);
      } finally {
        await framework.stop();
      }
    });

    it('a long error is answered and logged bounded', async () => {
      const { framework, connection } = await wiredFramework();
      try {
        (framework as unknown as { pushHandler: unknown }).pushHandler = {
          handlePushEvent: async () => { throw new Error('x'.repeat(5000)); },
        };
        const push = responder();
        connection.emit('push-event', { featureSet: 'chat', eventId: 'e9', payload: { content: [{ type: 'text', text: 'x' }] } }, push);
        await answered(push);
        const message = push.answers[0]!.error!.message;
        assert.ok(message.length < 600, `answered ${message.length} characters`);
        assert.match(message, /… \(5000 characters\)$/);
      } finally {
        await framework.stop();
      }
    });

    it('a request the handler already answered is not answered again when the handler then throws', async () => {
      const { framework, connection } = await wiredFramework();
      try {
        (framework as unknown as { pushHandler: unknown }).pushHandler = {
          handlePushEvent: async (_s: string, _p: unknown, r: { respond(x: unknown): void }) => {
            r.respond({ accepted: true });
            throw new Error('the trace emit broke');
          },
        };
        const push = responder();
        connection.emit('push-event', { featureSet: 'chat', eventId: 'e10', payload: { content: [{ type: 'text', text: 'x' }] } }, push);
        await answered(push);
        await until(() => logged.some((line) => line.includes('failed after it was answered')), 'the log line');

        assert.deepEqual(push.answers, [{ result: { accepted: true } }]);
        assert.ok(logged.some((line) => line.includes('push/event from srv failed after it was answered: the trace emit broke')), logged.join('\n'));
        assert.deepEqual(rejections, []);
      } finally {
        await framework.stop();
      }
    });

    it("a handler's answer that throws, such as a result JSON can't hold, isn't counted, so the request still gets the listener's answer", async () => {
      const { framework, connection } = await wiredFramework();
      try {
        standIns(framework, async (_s: string, _p: unknown, r: { respond(x: unknown): void }) => {
          r.respond({ accepted: true, sequence: 1n });
        });
        const push = responder({ serializes: true });
        connection.emit('push-event', { featureSet: 'chat', eventId: 'e21', payload: { content: [{ type: 'text', text: 'x' }] } }, push);
        await answered(push);

        assert.deepEqual(push.answers, [{ error: { code: -32603, message: 'Do not know how to serialize a BigInt' } }]);
        assert.ok(!logged.some((line) => line.includes('failed after it was answered')), logged.join('\n'));
        assert.deepEqual(rejections, []);
      } finally {
        await framework.stop();
      }
    });

    it('a handler that answers after its failure was answered is refused, so the server gets one response', async () => {
      const { framework, connection } = await wiredFramework();
      try {
        standIns(framework, async (_s: string, _p: unknown, r: { respond(x: unknown): void }) => {
          setImmediate(() => r.respond({ accepted: true }));
          throw new Error('the handler broke first');
        });
        const push = responder();
        connection.emit('push-event', { featureSet: 'chat', eventId: 'e22', payload: { content: [{ type: 'text', text: 'x' }] } }, push);
        await answered(push);
        await until(() => logged.some((line) => line.includes('a second answer (respond) was refused')), 'the refused second answer');
        await turn();

        assert.deepEqual(push.answers, [{ error: { code: -32603, message: 'the handler broke first' } }]);
        assert.ok(logged.some((line) => line.includes('push/event from srv: a second answer (respond) was refused; the request was already answered')), logged.join('\n'));
        assert.deepEqual(rejections, []);
      } finally {
        await framework.stop();
      }
    });

    it('a responder without respondError reaches the handler without one', async () => {
      const { framework, connection } = await wiredFramework();
      try {
        let seen: string | undefined;
        standIns(framework, async (_s: string, _p: unknown, r: { respond(x: unknown): void; respondError?: unknown }) => {
          seen = typeof r.respondError;
          r.respond({ results: [] });
        });
        const answers: unknown[] = [];
        connection.emit('channels-incoming', { messages: [{ channelId: 'c', messageId: 'm23', content: [] }] }, {
          id: 7, respond: (result: unknown) => { answers.push(result); },
        });
        await until(() => answers.length > 0, 'the answer');
        await turn();

        assert.equal(seen, 'undefined', "a handler checking for respondError takes its fallback");
        assert.deepEqual(answers, [{ results: [] }]);
        assert.deepEqual(rejections, []);
      } finally {
        await framework.stop();
      }
    });

    it("every request listener answers its handler's throw -32603 with its error, never rejecting into the listener", async () => {
      const { framework, connection } = await wiredFramework();
      try {
        standIns(framework, async () => { throw new Error('the handler broke'); });
        const answers = requests.map(([event, , params]) => {
          const r = responder();
          connection.emit(event, params, r);
          return r;
        });
        await answered(...answers);

        for (const [i, [, method]] of requests.entries()) {
          assert.deepEqual(answers[i]!.answers, [{ error: { code: -32603, message: 'the handler broke' } }], method);
          assert.ok(logged.some((line) => line.includes(`${method} from srv failed: the handler broke`)), `${method}:\n${logged.join('\n')}`);
        }
        assert.deepEqual(rejections, []);
      } finally {
        await framework.stop();
      }
    });

    it('an inference request during a render is refused -32600, and a throwing responder there is not rejected into the listener', async () => {
      const { framework, connection } = await wiredFramework();
      try {
        const fw = framework as unknown as { pushCoalescer: unknown };
        const coalescer = fw.pushCoalescer;
        fw.pushCoalescer = { isRendering: () => true, suspend: () => {}, flush: () => {} };
        const inference = responder({ throws: true });
        connection.emit('inference-request', { messages: [] }, inference);
        await answered(inference);

        assert.deepEqual(inference.answers, [{ error: { code: -32600, message: 'Cannot request inference while push/render is in progress' } }]);
        assert.deepEqual(rejections, []);
        fw.pushCoalescer = coalescer;
      } finally {
        await framework.stop();
      }
    });

    it('a responder that throws while answering is logged, never rejected into the listener', async () => {
      const { framework, connection } = await wiredFramework();
      await framework.stop();
      const push = responder({ throws: true });
      connection.emit('push-event', { featureSet: 'chat', eventId: 'e11', payload: { content: [{ type: 'text', text: 'x' }] } }, push);
      await answered(push);

      assert.deepEqual(push.answers, [stopping]);
      assert.ok(logged.some((line) => line.includes('push/event from srv refused: the host is stopping')), logged.join('\n'));
      assert.deepEqual(rejections, []);
    });
  });
});
