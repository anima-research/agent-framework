/**
 * stop() with work still in flight.
 *
 * stop() closes the process queue first and closes MCPL connections later,
 * so for a while work started before stop() keeps completing, and servers
 * keep sending. Two outcomes, one boundary (found through #256's aborted-
 * stream test, where a robot--move outlived the framework; the race itself
 * is older than #256):
 *   - a tool's result that arrives after stop() is logged and dropped: the
 *     stream that asked is gone, and the tool has already run. Before, its
 *     push threw "Queue is closed", the throw was misreported as the tool's
 *     failure, and that failure's push threw again, unhandled;
 *   - a server's push or incoming message the host can't take any more is
 *     answered with a JSON-RPC error, never "accepted", and never thrown
 *     out of the connection's listener.
 * Fresh input to a stopped framework still throws to its caller.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  /** Settle the running call; resolves once its completion callbacks have run. */
  async finish(outcome: 'success' | 'failure'): Promise<void> {
    if (outcome === 'success') this.settle!.resolve({ success: true, data: { done: true } });
    else this.settle!.reject(new Error('the work failed'));
    await new Promise((r) => setTimeout(r, 20));
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

  it('a tool that succeeds after stop() has its result dropped, not thrown or misreported as a failure', async () => {
    const { framework, module, failed } = await frameworkWithRunningTool();
    await framework.stop();
    await module.finish('success');

    assert.deepEqual(rejections, []);
    assert.deepEqual(failed, [], 'the tool succeeded; nothing reports it as a failure');
    assert.equal(dropped().length, 1, logged.join('\n'));
    // The drop names the tool and that it succeeded: what an operator needs
    // to reconcile a result nothing could take.
    assert.match(dropped()[0]!, /tool call c1 \(slow--work, slow\)/, dropped()[0]);
    assert.match(dropped()[0]!, /the tool succeeded$/, dropped()[0]);
  });

  it('a tool that fails after stop() has its error result dropped, not thrown', async () => {
    const { framework, module, failed } = await frameworkWithRunningTool();
    await framework.stop();
    await module.finish('failure');

    assert.deepEqual(rejections, []);
    assert.deepEqual(failed, [], 'the registry answers a module throw with an error result');
    assert.equal(dropped().length, 1, logged.join('\n'));
    assert.match(dropped()[0]!, /the tool failed: /, dropped()[0]);
  });

  it('a dispatch that rejects after stop() is reported as failed, and its failure result dropped, not thrown', async () => {
    const { framework, module, failed } = await frameworkWithRunningTool({ dispatch: 'rejects' });
    await framework.stop();
    await module.finish('success');

    assert.deepEqual(rejections, []);
    assert.equal(failed.length, 1, 'the host got no result: a dispatch failure');
    assert.equal(dropped().length, 1, logged.join('\n'));
    assert.match(dropped()[0]!, /tool call c1 \(slow--work, slow\)/, dropped()[0]);
    assert.match(dropped()[0]!, /the tool failed: .*the dispatch was lost/, dropped()[0]);
  });

  it('fresh input to a stopped framework still throws to its caller', async () => {
    const { framework, module } = await frameworkWithRunningTool();
    await framework.stop();
    assert.throws(
      () => framework.pushEvent({ type: 'external-message', source: 'test', content: 'too late', metadata: {} } as unknown as ProcessEvent),
      /Queue is closed/,
    );
    await module.finish('success');
    assert.deepEqual(rejections, []);
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

    function responder() {
      const answers: Array<{ result?: unknown; error?: { code: number; message: string } }> = [];
      return {
        answers,
        respond: (result: unknown) => { answers.push({ result }); },
        respondError: (code: number, message: string) => { answers.push({ error: { code, message } }); },
      };
    }

    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

    it('a push or incoming message after stop() is answered with an error, never accepted', async () => {
      const { framework, connection } = await wiredFramework();
      let handled = 0;
      (framework as unknown as { pushHandler: unknown }).pushHandler = { handlePushEvent: async () => { handled++; } };
      await framework.stop();

      const push = responder();
      connection.emit('push-event', { featureSet: 'chat', eventId: 'e1', payload: { content: [{ type: 'text', text: 'late' }] } }, push);
      const incoming = responder();
      connection.emit('channels-incoming', { messages: [{ channelId: 'c', messageId: 'm', content: [] }] }, incoming);
      await settle();

      assert.equal(handled, 0, 'never handed to the push handler, which would record it as accepted');
      assert.deepEqual(push.answers, [{ error: { code: -32603, message: 'the host is stopping' } }]);
      assert.deepEqual(incoming.answers, [{ error: { code: -32603, message: 'the host is stopping' } }]);
      assert.deepEqual(rejections, []);
    });

    it('a push held at the awareness barrier while the host stops is refused once the barrier lifts', async () => {
      const { framework, connection } = await wiredFramework();
      let lift!: () => void;
      (framework as unknown as { discordAwarenessBarrier: unknown }).discordAwarenessBarrier = {
        promise: new Promise<void>((r) => { lift = r; }),
      };
      let handled = 0;
      (framework as unknown as { pushHandler: unknown }).pushHandler = { handlePushEvent: async () => { handled++; } };

      const push = responder();
      connection.emit('push-event', { featureSet: 'chat', eventId: 'e2', payload: { content: [{ type: 'text', text: 'waiting' }] } }, push);
      await framework.stop();
      lift();
      await settle();

      assert.equal(handled, 0);
      assert.deepEqual(push.answers, [{ error: { code: -32603, message: 'the host is stopping' } }]);
      assert.deepEqual(rejections, []);
    });

    it('a handler that throws is answered with its error, not rejected into the listener; a notification is only logged', async () => {
      const { framework, connection } = await wiredFramework();
      (framework as unknown as { pushHandler: unknown }).pushHandler = {
        handlePushEvent: async () => { throw new Error('the handler broke'); },
      };

      const push = responder();
      connection.emit('push-event', { featureSet: 'chat', eventId: 'e3', payload: { content: [{ type: 'text', text: 'x' }] } }, push);
      connection.emit('push-event', { featureSet: 'chat', eventId: 'e4', payload: { content: [{ type: 'text', text: 'y' }] } });
      await settle();

      assert.deepEqual(push.answers, [{ error: { code: -32603, message: 'the handler broke' } }]);
      assert.deepEqual(rejections, []);
      await framework.stop();
    });

    it('a handler that rejects with nothing is a failed request on a live host, not a stopping refusal', async () => {
      const { framework, connection } = await wiredFramework();
      (framework as unknown as { pushHandler: unknown }).pushHandler = {
        // eslint-disable-next-line prefer-promise-reject-errors
        handlePushEvent: () => Promise.reject(),
      };
      const fw = framework as unknown as { channelRegistry: unknown };
      const registry = fw.channelRegistry;
      fw.channelRegistry = { handleIncoming: async () => { throw undefined; } };

      const push = responder();
      connection.emit('push-event', { featureSet: 'chat', eventId: 'e5', payload: { content: [{ type: 'text', text: 'x' }] } }, push);
      const incoming = responder();
      connection.emit('channels-incoming', { messages: [{ channelId: 'c', messageId: 'm', content: [] }] }, incoming);
      await settle();

      assert.deepEqual(push.answers, [{ error: { code: -32603, message: 'the handler failed' } }]);
      assert.deepEqual(incoming.answers, [{ error: { code: -32603, message: 'the handler failed' } }]);
      assert.ok(logged.some((line) => line.includes('push/event from srv failed: the handler failed')), logged.join('\n'));
      assert.ok(!logged.some((line) => line.includes('refused')), 'a live host refuses nothing');
      assert.deepEqual(rejections, []);
      fw.channelRegistry = registry;
      await framework.stop();
    });
  });
});
