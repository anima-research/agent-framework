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
import ts from 'typescript';
import type { ContentBlock } from '@animalabs/membrane';
import type {
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
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

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
    // object literal in src whose `type` is the string 'tool-result' (in any
    // quoting) carries toolName, and where its callId and toolName both read
    // a call (`X.id`, `Y.name`), they read the same one. Read as TypeScript's
    // syntax tree, not as text, so no spelling of the literal escapes the check.
    const src = fileURLToPath(new URL('../../src/', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(src);
    const nameOf = (n: ts.PropertyName): string | undefined =>
      ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : undefined;
    const isToolResult = (e: ts.Expression): boolean => {
      while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
      return (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && e.text === 'tool-result';
    };
    // The call an `X.id` or `X.name` reads, as source text (`call`, `tc`).
    const callRead = (p: ts.ObjectLiteralElementLike | undefined, field: 'id' | 'name'): string | undefined => {
      if (!p || !ts.isPropertyAssignment(p)) return undefined;
      const e = p.initializer;
      return ts.isPropertyAccessExpression(e) && e.name.text === field ? e.expression.getText() : undefined;
    };
    const missing: string[] = [];
    const mismatched: string[] = [];
    let literals = 0;
    let paired = 0;
    for (const file of files) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const type = node.properties.find((p) => ts.isPropertyAssignment(p) && nameOf(p.name) === 'type');
          if (type && ts.isPropertyAssignment(type) && isToolResult(type.initializer)) {
            literals++;
            const where = `${file.slice(src.length)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
            const property = (name: string) => node.properties.find((p) =>
              (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && nameOf(p.name) === name);
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
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    assert.ok(literals > 20, `found ${literals} tool-result literals; the scan has lost them`);
    assert.deepEqual(missing, [], 'tool-result events without toolName');
    assert.ok(paired > 20, `paired ${paired} callId/toolName reads; the pairing has lost them`);
    assert.deepEqual(mismatched, [], "tool-result events naming another call's tool");
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
