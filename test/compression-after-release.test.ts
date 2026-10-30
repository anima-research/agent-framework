import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AnthropicAdapter, Membrane, MembraneError, NativeFormatter } from '@animalabs/membrane';
import { CompressionWithdrawn } from '@animalabs/context-manager';
import { JsStore } from '@animalabs/chronicle';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolDefinition, ToolResult } from '../src/index.js';
import { Agent, AgentFramework, AutobiographicalStrategy, PassthroughStrategy, taskForkSpec } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

class CompressionMembrane extends MockMembrane {
  readonly compressions: number[] = [];
  readonly aborted: number[] = [];
  readonly formatted: boolean[] = [];
  inFlight = 0;
  constructor(private readonly delayMs: number) { super(); }
  override async complete(_request: NormalizedRequest, options?: { signal?: AbortSignal; formatter?: unknown }): Promise<NormalizedResponse> {
    this.compressions.push(Date.now());
    this.formatted.push((options?.formatter as { constructor?: { name?: string } } | undefined)?.constructor?.name === 'NativeFormatter');
    this.inFlight++;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          this.aborted.push(Date.now());
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        };
        const timer = setTimeout(resolve, this.delayMs);
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener('abort', abort, { once: true });
      });
    } finally {
      this.inFlight--;
    }
    return createMockResponse([{ type: 'text', text: `Summary ${this.compressions.length}: the exchange went on.` }]);
  }
}

class RetriedProvider extends AnthropicAdapter {
  calls = 0;
  aborted = 0;
  failed = 0;
  out = 0;
  constructor() { super({ apiKey: 'test', cacheKeepalive: { enabled: false } } as never); }
  override async complete(_request: unknown, options?: { signal?: AbortSignal }): Promise<never> {
    this.calls++;
    this.out++;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        this.aborted++;
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      };
      const timer = setTimeout(() => {
        options?.signal?.removeEventListener('abort', abort);
        resolve();
      }, 300);
      options?.signal?.addEventListener('abort', abort, { once: true });
    }).finally(() => { this.out--; });
    this.failed++;
    throw new MembraneError({ type: 'server', message: 'injected server error', retryable: true, httpStatus: 500 } as never);
  }
}

class AbortingProvider extends AnthropicAdapter {
  calls = 0;
  abortedOnArrival = 0;
  constructor() { super({ apiKey: 'test', cacheKeepalive: { enabled: false } } as never); }
  override async complete(_request: unknown, options?: { signal?: AbortSignal }): Promise<never> {
    this.calls++;
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    if (options?.signal?.aborted) {
      this.abortedOnArrival++;
      throw error;
    }
    await new Promise<void>((_resolve, reject) => { options?.signal?.addEventListener('abort', () => reject(error), { once: true }); });
    throw error;
  }
}

class DetachRecorded extends PassthroughStrategy {
  detached = false;
  detach(): void { this.detached = true; }
}

async function settle(membrane: CompressionMembrane): Promise<void> {
  const end = Date.now() + 5_000;
  while (membrane.inFlight > 0 && Date.now() < end) await sleep(5);
  await sleep(50);
}

class Quiet implements Module {
  readonly name = 'test';
  constructor(private readonly stopMs = 0) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> { if (this.stopMs > 0) await new Promise((resolve) => setTimeout(resolve, this.stopMs)); }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: true }; }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
}

class Held implements Module {
  readonly name = 'held';
  calls = 0;
  private opened!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.opened = resolve; });
  open(): void { this.opened(); }
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return [{ name: 'wait', description: 'Wait until let go.', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(): Promise<ToolResult> {
    this.calls++;
    await this.gate;
    return { success: true, data: 'let go' };
  }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(5);
  }
}

function captureErrors(): { lines: string[]; uncaught: string[]; restore: () => void } {
  const lines: string[] = [];
  const uncaught: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));
  };
  const onUncaught = (e: unknown) => { uncaught.push(e instanceof Error ? e.message : String(e)); };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  return { lines, uncaught, restore: () => {
    console.error = original;
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
  } };
}
const maintenanceStopped = /^\[context-maintenance\] agent=\S+ stopped: maintenance call withdrawn/;
const drainLines = (lines: string[]) => lines.filter((line) =>
  !maintenanceStopped.test(line) && /withdrawn|Failed to compress|Failed to merge|speculative-drain|closed/i.test(line));

function drainingStrategy(autoTickOnNewMessage = true) {
  return new AutobiographicalStrategy({
    compressionModel: 'test-compression-model', targetChunkTokens: 50, headWindowTokens: 0,
    recentWindowTokens: 0, autoTickOnNewMessage, minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
  });
}

const detachedStrategies = new WeakSet<object>();

async function setup(prefix: string, membrane: CompressionMembrane, more: {
  stopMs?: number; modules?: Module[]; maintenanceIntervalMs?: number; agents?: boolean; residentDrains?: boolean; store?: JsStore;
  forkStrategies?: AutobiographicalStrategy[]; subconscious?: boolean; forksTickOnlyInMaintenance?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const framework = await AgentFramework.create({
    ...(more.store ? { store: more.store } : { storePath: join(dir, 'store.chronicle') }),
    membrane: membrane.asMembrane(),
    agents: more.agents ? [{ name: 'trunk', model: 'test-model', systemPrompt: 'test', ...(more.residentDrains ? { strategy: drainingStrategy() } : {}) }] : [],
    modules: [new Quiet(more.stopMs ?? 0), ...(more.modules ?? [])], syncIntervalMs: 0, maintenanceIntervalMs: more.maintenanceIntervalMs ?? 0,
    ...(more.agents ? { conversations: { templateAgent: 'trunk', bind: { channel: 'mention' as const }, strategyFactory: () => {
      const strategy = drainingStrategy(!more.forksTickOnlyInMaintenance);
      if (more.forkStrategies) {
        const detach = strategy.detach?.bind(strategy);
        strategy.detach = () => { detachedStrategies.add(strategy); detach?.(); };
        more.forkStrategies.push(strategy);
      }
      return strategy;
    } } } : {}),
    ...(more.subconscious ? { subconscious: { enabled: true, systemPrompt: 'notice' } } : {}),
  });
  return { dir, framework };
}

type ForkInternals = {
  createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<unknown>;
  disposeConversationAgent(name: string): void;
  reserveStoreForSurgery(verb: string, agentName: string): () => void;
  addMessage(participant: string, content: unknown, metadata?: unknown, opts?: { forAgent?: string }): string;
};
const home = { serverId: 'world', channelId: 'world:chan' };

async function createDraining(framework: AgentFramework, name = 'worker') {
  return framework.createEphemeralAgent({
    name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', strategy: drainingStrategy(),
  });
}

function addBacklog(contextManager: { addMessage: Awaited<ReturnType<typeof createDraining>>['contextManager']['addMessage'] }, count: number, from = 0): void {
  for (let i = from; i < from + count; i++) {
    contextManager.addMessage(i % 2 === 0 ? 'user' : 'worker', [{ type: 'text', text: `message ${i}: ` + 'word '.repeat(30) }]);
  }
}

describe('a context manager the framework is done with makes no further provider call (#550)', () => {
  it('an ephemeral run that has ended, with compression still queued', { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(200);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const { dir, framework } = await setup('af-done-run-', membrane);
    const errors = captureErrors();
    try {
      const { agent, contextManager } = await createDraining(framework);
      addBacklog(contextManager, 30);
      contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      await until(() => membrane.compressions.length >= 1);
      const run = framework.runEphemeralToCompletion(agent, contextManager);
      framework.start();
      await run;
      assert.equal(contextManager.isReady(), false, 'compression is still queued when the run ends');
      const sent = membrane.compressions.length;
      await sleep(1_000);
      assert.equal(membrane.compressions.length, sent, 'no compression call reached the provider after the run ended');
      await assert.rejects(contextManager.resetHeadWindow(), (error: unknown) => error instanceof CompressionWithdrawn,
        'a reset with no text is withdrawn');
      assert.equal(membrane.compressions.length, sent, 'and reached no provider');
      assert.deepEqual(drainLines(errors.lines), []);
    } finally {
      errors.restore();
      await settle(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a shared-inheritance run that has ended, with compression still queued (the derived manager is on the run\'s membrane)', { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(200);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const { dir, framework } = await setup('af-done-shared-', membrane, { agents: true });
    const errors = captureErrors();
    try {
      // The parent's slot carries the backlog; the child inherits it shared, on
      // its own branch, with a draining strategy, so compression queues on the
      // derived manager (which, before the tenth round, was on the framework's
      // membrane and so outlived the run's release).
      addBacklog(framework.getAgent('trunk')!.getContextManager(), 30);
      const { agent, contextManager } = await framework.createEphemeralAgent(
        { name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', strategy: drainingStrategy() },
        taskForkSpec('worker', { parent: 'trunk', inherit: { mode: 'shared' } }),
      );
      contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      await until(() => membrane.compressions.length >= 1);
      const run = framework.runEphemeralToCompletion(agent, contextManager);
      framework.start();
      await run;
      const sent = membrane.compressions.length;
      await sleep(1_000);
      assert.equal(membrane.compressions.length, sent, 'no compression call reached the provider after the run ended');
      await assert.rejects(contextManager.resetHeadWindow(), (error: unknown) => error instanceof CompressionWithdrawn,
        'a reset with no text is withdrawn');
      assert.equal(membrane.compressions.length, sent, 'and reached no provider');
      assert.deepEqual(drainLines(errors.lines), []);
    } finally {
      errors.restore();
      await settle(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a resumed job after cleanup(): the call its manager has out is aborted, and it makes no call', { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(100);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const { dir, framework } = await setup('af-done-resumed-', membrane);
    const errors = captureErrors();
    try {
      const first = await framework.createEphemeralAgent({ name: 'job', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' });
      first.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      const run = framework.runEphemeralToCompletion(first.agent, first.contextManager);
      framework.start();
      await run;
      const resumed = await framework.resumeAgent('job', {
        model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', strategy: drainingStrategy(),
      });
      addBacklog(resumed.contextManager, 30);
      await until(() => membrane.compressions.length >= 1 && membrane.inFlight > 0);
      resumed.cleanup();
      const sent = membrane.compressions.length;
      await sleep(800);
      assert.equal(membrane.compressions.length, sent, 'no compression call reached the provider after cleanup()');
      assert.ok(membrane.aborted.length >= 1, 'the call it had out was aborted');
      assert.deepEqual(drainLines(errors.lines), []);
    } finally {
      errors.restore();
      await settle(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('after cleanup() with no run: the call it has out is aborted, it makes no call, and another agent compresses as before', { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(100);
    const { dir, framework } = await setup('af-done-cleanup-', membrane);
    const errors = captureErrors();
    try {
      const released = await createDraining(framework, 'released');
      addBacklog(released.contextManager, 30);
      await until(() => membrane.compressions.length >= 1 && membrane.inFlight > 0);
      released.cleanup();
      const sent = membrane.compressions.length;
      await sleep(800);
      assert.equal(membrane.compressions.length, sent, "no compression call reached the provider after cleanup()");
      assert.ok(membrane.aborted.length >= 1, 'the call it had out was aborted');
      assert.ok(membrane.formatted.length > 0 && membrane.formatted.every(Boolean), 'each call kept the strategy\'s NativeFormatter');
      const other = await createDraining(framework, 'other');
      addBacklog(other.contextManager, 6);
      await until(() => membrane.compressions.length > sent);
      other.cleanup();
      assert.deepEqual(drainLines(errors.lines), []);
    } finally {
      errors.restore();
      await settle(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('after cleanup() while its run is still going: no call, and the run goes on to its end', { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(100);
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'call_1', name: 'held--wait', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const held = new Held();
    const { dir, framework } = await setup('af-done-midrun-', membrane, { modules: [held], maintenanceIntervalMs: 20 });
    const errors = captureErrors();
    try {
      const { agent, contextManager, cleanup } = await createDraining(framework);
      addBacklog(contextManager, 30);
      contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      await until(() => membrane.compressions.length >= 1);
      const run = framework.runEphemeralToCompletion(agent, contextManager);
      framework.start();
      await until(() => held.calls === 1);
      cleanup();
      const sent = membrane.compressions.length;
      await sleep(800);
      assert.equal(membrane.compressions.length, sent, 'no compression call reached the provider after cleanup()');
      held.open();
      const { speech } = await run;
      assert.equal(speech, 'Done.', 'the run went on to its end');
      assert.equal(membrane.compressions.length, sent, 'nor while the run went on to its end');
      assert.deepEqual(drainLines(errors.lines), []);
      const stopped = errors.lines.filter((line) => maintenanceStopped.test(line));
      assert.ok(stopped.length <= 1, `no maintenance pass after cleanup() ticked it, but one already ticking: ${JSON.stringify(stopped)}`);
    } finally {
      errors.restore();
      held.open();
      await settle(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a run after cleanup() is refused in the framework's own words, while quiesced and after stop()", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(100);
    const { dir, framework } = await setup('af-done-refused-', membrane);
    try {
      framework.start();
      const { agent, contextManager, cleanup } = await createDraining(framework, 'retired');
      cleanup();
      await framework.quiesce({ reason: 'test window' });
      await assert.rejects(framework.runEphemeralToCompletion(agent, contextManager), /was released by cleanup\(\) and can't run/);
      await framework.resume();
      await framework.stop();
      await assert.rejects(framework.runEphemeralToCompletion(agent, contextManager), /was released by cleanup\(\) and can't run/);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('once stop() has begun, an ephemeral manager makes no call while stop() is still tearing down', { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(50);
    const { dir, framework } = await setup('af-done-stop-', membrane, { stopMs: 300 });
    const errors = captureErrors();
    try {
      framework.start();
      const { contextManager, cleanup } = await createDraining(framework);
      addBacklog(contextManager, 40);
      await until(() => membrane.compressions.length >= 1);
      const sent = membrane.compressions.length;
      await framework.stop();
      await sleep(300);
      assert.equal(membrane.compressions.length, sent, 'no compression call reached the provider once stop() had begun');
      assert.deepEqual(drainLines(errors.lines), []);
      cleanup();
    } finally {
      errors.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a disposed conversation fork makes no call, and the call it had out is aborted", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(100);
    const { dir, framework } = await setup('af-done-fork-', membrane, { agents: true });
    const internals = framework as unknown as ForkInternals;
    const errors = captureErrors();
    try {
      await internals.createConversationAgent('trunk-chan-g1', home);
      const fork = framework.getAgent('trunk-chan-g1')!.getContextManager();
      addBacklog(fork, 30);
      await until(() => membrane.compressions.length >= 1 && membrane.inFlight > 0);
      internals.disposeConversationAgent('trunk-chan-g1');
      const sent = membrane.compressions.length;
      await sleep(800);
      assert.equal(membrane.compressions.length, sent, 'no compression call reached the provider after the fork was disposed');
      assert.ok(membrane.aborted.length >= 1, 'the call it had out was aborted');
      await assert.rejects(fork.resetHeadWindow(), (error: unknown) => error instanceof CompressionWithdrawn,
        'a reset with no text is withdrawn');
      assert.equal(membrane.compressions.length, sent);
      assert.deepEqual(drainLines(errors.lines), []);
    } finally {
      errors.restore();
      await settle(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a fork disposed while a maintenance pass's call for it is out: the call is aborted, and the pass says it was withdrawn, not that it failed", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(10_000);
    const { dir, framework } = await setup('af-done-fork-tick-', membrane, { agents: true, maintenanceIntervalMs: 20, forksTickOnlyInMaintenance: true });
    const internals = framework as unknown as ForkInternals;
    const errors = captureErrors();
    try {
      await internals.createConversationAgent('trunk-chan-g1', home);
      addBacklog(framework.getAgent('trunk-chan-g1')!.getContextManager(), 30);
      framework.start();
      await until(() => membrane.inFlight > 0);
      internals.disposeConversationAgent('trunk-chan-g1');
      const sent = membrane.compressions.length;
      await until(() => membrane.aborted.length >= 1);
      await until(() => errors.lines.some((line) => maintenanceStopped.test(line) && line.includes('agent=trunk-chan-g1')));
      await sleep(500);
      assert.equal(membrane.compressions.length, sent, 'no call after the disposal');
      assert.equal(errors.lines.filter((line) => maintenanceStopped.test(line) && line.includes('agent=trunk-chan-g1')).length, 1,
        'the pass says once that its call was withdrawn');
      assert.deepEqual(errors.lines.filter((line) => /^\[context-maintenance\] agent=trunk-chan-g1 failed/.test(line)), [],
        'the maintenance pass reports no failure for the call the disposal aborted');
    } finally {
      errors.restore();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a fork whose creation fails partway makes no call, and a fork made again under its name compresses as before", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(100);
    const forkStrategies: AutobiographicalStrategy[] = [];
    const { dir, framework } = await setup('af-done-fork-failed-', membrane, { agents: true, forkStrategies });
    const internals = framework as unknown as ForkInternals;
    const errors = captureErrors();
    try {
      const template = framework.getAgent('trunk')!.getContextManager();
      addBacklog(template, 30);
      await settle(membrane);
      const before = membrane.compressions.length;
      const compile = template.compile.bind(template);
      template.compile = async (...args: Parameters<typeof compile>) => {
        const compiled = await compile(...args);
        return { ...compiled, messages: [...compiled.messages, { ...compiled.messages[0]!, content: ['not a content block'] as never }] };
      };
      await assert.rejects(internals.createConversationAgent('trunk-chan-g1', home), /refused/);
      assert.equal(forkStrategies.length, 1, 'the failed fork opened its manager');
      assert.equal(detachedStrategies.has(forkStrategies[0]!), true, "the failed fork's manager was closed");
      await sleep(800);
      assert.equal(membrane.compressions.length, before, "no compression call reached the provider for the fork that wasn't made");
      template.compile = compile;
      await internals.createConversationAgent('trunk-chan-g1', home);
      addBacklog(framework.getAgent('trunk-chan-g1')!.getContextManager(), 6, 30);
      await until(() => membrane.compressions.length > before);
      internals.disposeConversationAgent('trunk-chan-g1');
      assert.deepEqual(drainLines(errors.lines), []);
    } finally {
      errors.restore();
      await settle(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("under a surgery's hold an ephemeral manager makes no call, and its calls go out once the hold is released", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(20);
    const { dir, framework } = await setup('af-done-surgery-', membrane);
    const internals = framework as unknown as ForkInternals;
    const errors = captureErrors();
    try {
      const { contextManager, cleanup } = await createDraining(framework);
      const releaseHold = internals.reserveStoreForSurgery('roll back', 'agent');
      try {
        addBacklog(contextManager, 12);
        await sleep(500);
        assert.equal(membrane.compressions.length, 0, 'no compression call reached the provider under the hold');
      } finally {
        releaseHold();
      }
      addBacklog(contextManager, 2, 12);
      await until(() => membrane.compressions.length >= 1);
      cleanup();
      assert.deepEqual(drainLines(errors.lines), []);
    } finally {
      errors.restore();
      await settle(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fork disposed on a quiesced host makes no call after the disposal, and its held writes land at the resume', { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(100);
    const { dir, framework } = await setup('af-done-quiesced-', membrane, { agents: true });
    const internals = framework as unknown as ForkInternals;
    const errors = captureErrors();
    try {
      await internals.createConversationAgent('trunk-chan-g1', home);
      const fork = framework.getAgent('trunk-chan-g1')!.getContextManager();
      addBacklog(fork, 40);
      await until(() => membrane.compressions.length >= 1);
      await framework.quiesce({ reason: 'test window' });
      assert.equal(internals.addMessage('user', [{ type: 'text', text: 'HELD WHILE QUIESCED' }], undefined, { forAgent: 'trunk-chan-g1' }), '');
      internals.disposeConversationAgent('trunk-chan-g1');
      const sent = membrane.compressions.length;
      await sleep(800);
      assert.equal(membrane.compressions.length, sent, 'no compression call reached the provider after the disposal');
      await framework.resume();
      assert.ok(fork.getAllMessages().some((message) => JSON.stringify(message.content).includes('HELD WHILE QUIESCED')),
        'its held write landed in its window at the resume');
      await sleep(300);
      assert.equal(membrane.compressions.length, sent, 'nor after the resume');
      assert.deepEqual(drainLines(errors.lines), []);
    } finally {
      errors.restore();
      await settle(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  for (const when of ['while its request is out', "while membrane waits to retry it"] as const) {
    it(`a call cleanup() comes to ${when} sends nothing more: membrane retries nothing`, { timeout: 60_000 }, async () => {
      const provider = new RetriedProvider();
      const dir = mkdtempSync(join(tmpdir(), 'af-done-retry-'));
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store.chronicle'),
        membrane: new Membrane(provider, { formatter: new NativeFormatter(), retry: { maxRetries: 5, retryDelayMs: when === 'while its request is out' ? 10 : 2_000 } }),
        agents: [], modules: [new Quiet()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      });
      const errors = captureErrors();
      try {
        const { contextManager, cleanup } = await createDraining(framework);
        addBacklog(contextManager, 30);
        await until(() => (when === 'while its request is out' ? provider.out > 0 : provider.failed >= 1 && provider.out === 0));
        const calls = provider.calls;
        const aborted = provider.aborted;
        const at = `at cleanup(): ${JSON.stringify({ calls, aborted, failed: provider.failed, out: provider.out })}`;
        cleanup();
        await sleep(when === 'while its request is out' ? 1_500 : 5_000);
        const now = `${at}; after: ${JSON.stringify({ calls: provider.calls, aborted: provider.aborted, failed: provider.failed, out: provider.out })}`;
        assert.equal(provider.aborted, aborted + (when === 'while its request is out' ? 1 : 0), `the request out was aborted, if one was (${now})`);
        assert.equal(provider.calls, calls, `membrane sent no retry after cleanup() (${now})`);
      } finally {
        errors.restore();
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('an ephemeral agent whose creation fails after its manager opened has that manager closed', { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(50);
    const { dir, framework } = await setup('af-done-ephemeral-failed-', membrane);
    const strategy = new DetachRecorded();
    const consumed = Agent.prototype.markContextConsumed;
    Agent.prototype.markContextConsumed = function () { throw new Error('injected creation failure'); };
    try {
      await assert.rejects(framework.createEphemeralAgent({ name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', strategy }),
        /injected creation failure/);
    } finally {
      Agent.prototype.markContextConsumed = consumed;
    }
    try {
      assert.equal(strategy.detached, true, 'its manager was closed');
      const again = await createDraining(framework);
      again.cleanup();
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('none of a context manager\'s work runs after its store closes (#550)', () => {
  it("a released ephemeral manager stays open, so a write after cleanup() lands, until stop() with a store it owns closes it", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(50);
    const { dir, framework } = await setup('af-done-released-open-', membrane);
    try {
      const { contextManager, cleanup } = await createDraining(framework);
      const strategy = contextManager.getStrategy() as unknown as { detach?: () => void };
      const detach = strategy.detach?.bind(strategy);
      let detached = false;
      strategy.detach = () => { detached = true; detach?.(); };
      cleanup();
      assert.equal(contextManager.isClosed(), false, 'it is open after cleanup()');
      contextManager.addMessage('user', [{ type: 'text', text: 'A RECEIPT AFTER CLEANUP' }]);
      assert.ok(contextManager.getAllMessages().some((message) => JSON.stringify(message.content).includes('A RECEIPT AFTER CLEANUP')),
        'the write landed');
      assert.equal(detached, false, 'its strategy is still attached');
      await framework.stop();
      assert.equal(detached, true, 'stop() closed it, detaching its strategy');
    } finally {
      await settle(membrane);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const then of ['cleanup() alone', 'cleanup() and then stop() with a store it owns'] as const) {
    it(`a released manager whose call is inside a beforeRequest hook at ${then}: the call leaves the hook withdrawn, and nothing of its work reads a closed store`, { timeout: 60_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'af-done-hook-'));
      let entered = 0;
      const provider = new AbortingProvider();
      const membrane = new Membrane(provider, { formatter: new NativeFormatter(), retry: { maxRetries: 0, retryDelayMs: 10 },
        hooks: { beforeRequest: async (_normalized: unknown, request: unknown) => { entered++; await sleep(1_000); return request; } } } as never);
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store.chronicle'), membrane, agents: [], modules: [new Quiet()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      });
      const errors = captureErrors();
      try {
        framework.start();
        const { contextManager, cleanup } = await createDraining(framework);
        addBacklog(contextManager, 30);
        await until(() => entered > 0);
        cleanup();
        if (then !== 'cleanup() alone') await framework.stop();
        await until(() => provider.calls >= 1);
        await sleep(200);
        assert.equal(provider.abortedOnArrival, 1, 'the call reached the provider on a signal already aborted');
        assert.equal(entered, 1, 'no further call entered the hook');
        assert.equal(provider.calls, 1, 'the provider was reached once');
        assert.deepEqual(errors.lines.filter((line) => /closed/i.test(line)), [], 'nothing of its work read a closed store');
      } finally {
        errors.restore();
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("stop() with a store it owns closes every manager still alive before the store, released ones included, and nothing of any manager's runs once the store has closed", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(300);
    const { dir, framework } = await setup('af-done-store-', membrane, { agents: true, residentDrains: true, subconscious: true });
    const internals = framework as unknown as ForkInternals;
    const errors = captureErrors();
    try {
      framework.start();
      const resident = framework.getAgent('trunk')!.getContextManager();
      const subconsciousName = (framework as unknown as { subconsciousAgentName: string }).subconsciousAgentName;
      const subconscious = framework.getAgent(subconsciousName)!.getContextManager();
      const live = await createDraining(framework, 'live');
      const released = await createDraining(framework, 'released');
      await internals.createConversationAgent('trunk-chan-g1', home);
      const fork = framework.getAgent('trunk-chan-g1')!.getContextManager();
      await internals.createConversationAgent('trunk-other-g1', { serverId: 'world', channelId: 'world:other' });
      const liveFork = framework.getAgent('trunk-other-g1')!.getContextManager();
      for (const manager of [resident, live.contextManager, released.contextManager, fork, liveFork]) addBacklog(manager, 30);
      await until(() => membrane.compressions.length >= 4 && membrane.inFlight > 0);
      released.cleanup();
      internals.disposeConversationAgent('trunk-chan-g1');
      const kept = [
        ['resident', resident], ['subconscious', subconscious], ['live ephemeral agent', live.contextManager], ['live fork', liveFork],
        ['released ephemeral agent', released.contextManager], ['disposed fork', fork],
      ] as const;
      const store = framework.getStore();
      const closeStore = store.close.bind(store);
      const closedFirst: string[] = [];
      store.close = () => {
        for (const [name, manager] of kept) if (manager.isClosed()) closedFirst.push(name);
        closeStore();
      };
      await framework.stop();
      const sent = membrane.compressions.length;
      assert.deepEqual(closedFirst, kept.map(([name]) => name), 'each manager it holds is closed before the store is');
      await sleep(1_000);
      assert.equal(membrane.compressions.length, sent, 'no compression call after stop()');
      assert.equal(membrane.inFlight, 0, 'no call is still out');
      assert.deepEqual(errors.lines.filter((line) => /closed|close\(\)/i.test(line)), [], 'nothing met the closed store or a closed manager');
      assert.deepEqual(errors.uncaught, []);
    } finally {
      errors.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a strategy whose detach() throws, and a manager the host already closed: stop() with a store it owns still closes every manager, and then the store", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(50);
    const { dir, framework } = await setup('af-done-detach-throws-', membrane, { agents: true, subconscious: true });
    const errors = captureErrors();
    try {
      framework.start();
      const resident = framework.getAgent('trunk')!.getContextManager();
      const subconsciousName = (framework as unknown as { subconsciousAgentName: string }).subconsciousAgentName;
      const subconscious = framework.getAgent(subconsciousName)!.getContextManager();
      const live = await createDraining(framework, 'live');
      const hostClosed = await createDraining(framework, 'host-closed');
      const strategy = resident.getStrategy() as unknown as { detach?: () => void };
      strategy.detach = () => { throw new Error('injected detach failure'); };
      hostClosed.contextManager.close();
      const kept = [['resident', resident], ['subconscious', subconscious], ['live ephemeral agent', live.contextManager]] as const;
      const store = framework.getStore();
      const closeStore = store.close.bind(store);
      const closedFirst: string[] = [];
      let storeClosed = false;
      store.close = () => {
        for (const [name, manager] of kept) if (manager.isClosed()) closedFirst.push(name);
        storeClosed = true;
        closeStore();
      };
      await framework.stop();
      assert.deepEqual(closedFirst, kept.map(([name]) => name), 'each manager is closed before the store, the one whose detach() threw included');
      assert.equal(storeClosed, true, 'the store is closed');
      assert.ok(errors.lines.some((line) => line.includes('injected detach failure')), 'context-manager logs the failed detach');
    } finally {
      errors.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a start() after a stop() that closed the managers and then failed to close its owned store is refused as after any failed stop()", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(50);
    const { dir, framework } = await setup('af-done-store-fails-', membrane, { agents: true });
    const store = framework.getStore();
    const closeStore = store.close.bind(store);
    try {
      framework.start();
      store.close = () => { throw new Error('injected store close failure'); };
      await assert.rejects(framework.stop(), /injected store close failure/);
      assert.equal(framework.getAgent('trunk')!.getContextManager().isClosed(), true, "the resident's manager is closed");
      assert.throws(() => framework.start(), /^Error: start\(\) refused: this framework's stop\(\) failed, and a stopped framework doesn't start again\. .*Call stop\(\) again/);
    } finally {
      store.close = closeStore;
      if (!store.isClosed()) closeStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stop() after one that had no manager to close and failed to close its owned store closes it", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(50);
    const { dir, framework } = await setup('af-done-store-fails-none-', membrane);
    const store = framework.getStore();
    const closeStore = store.close.bind(store);
    try {
      framework.start();
      store.close = () => { throw new Error('injected store close failure'); };
      await assert.rejects(framework.stop(), /injected store close failure/);
      store.close = closeStore;
      await framework.stop();
      assert.equal(store.isClosed(), true, 'the second stop() closed the store');
    } finally {
      store.close = closeStore;
      if (!store.isClosed()) closeStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stop() with a store the host owns leaves the managers open", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(50);
    const dir = mkdtempSync(join(tmpdir(), 'af-done-borrowed-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store.chronicle') });
    const { framework } = await setup('af-done-borrowed-x-', membrane, { agents: true, store });
    try {
      framework.start();
      const resident = framework.getAgent('trunk')!.getContextManager();
      await framework.stop();
      assert.equal(resident.isClosed(), false, "the resident's manager stays open");
    } finally {
      await settle(membrane);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stop() with a store it owns aborts the call a live ephemeral agent's manager has out", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(10_000);
    const { dir, framework } = await setup('af-done-store-call-out-', membrane);
    const errors = captureErrors();
    try {
      framework.start();
      const live = await createDraining(framework, 'live');
      addBacklog(live.contextManager, 30);
      await until(() => membrane.inFlight > 0);
      await framework.stop();
      assert.equal(live.contextManager.isClosed(), true, 'its manager is closed');
      await until(() => membrane.aborted.length >= 1);
      assert.equal(membrane.inFlight, 0, 'its call out ended with the abort');
    } finally {
      errors.restore();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed create() whose stop fails closes the managers it opened before the store it owns", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-done-failed-create-'));
    const strategy = new DetachRecorded();
    const failing: Module = {
      name: 'failing',
      async start() { throw new Error('injected start failure'); },
      async stop() { throw new Error('injected stop failure'); },
      getTools: () => [],
      async handleToolCall() { return { success: true }; },
      async onProcess() { return {}; },
    };
    const errors = captureErrors();
    const closeStore = JsStore.prototype.close;
    let detachedAtClose: boolean | undefined;
    JsStore.prototype.close = function (this: JsStore) {
      detachedAtClose ??= strategy.detached;
      return closeStore.call(this);
    };
    try {
      await assert.rejects(AgentFramework.create({
        storePath: join(dir, 'store.chronicle'),
        membrane: new CompressionMembrane(50).asMembrane(),
        agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'test', strategy }],
        modules: [failing], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      }), /injected start failure/);
      assert.equal(detachedAtClose, true, "the resident's manager was closed before the store");
      assert.deepEqual(errors.uncaught, []);
    } finally {
      JsStore.prototype.close = closeStore;
      errors.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed create() on a store the host owns closes the managers it opened, and leaves the store open", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-done-failed-create-borrowed-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store.chronicle') });
    const strategy = new DetachRecorded();
    const failing: Module = {
      name: 'failing',
      async start() { throw new Error('injected start failure'); },
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: true }; },
      async onProcess() { return {}; },
    };
    try {
      await assert.rejects(AgentFramework.create({
        store,
        membrane: new CompressionMembrane(50).asMembrane(),
        agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'test', strategy }],
        modules: [failing], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      }), /injected start failure/);
      assert.equal(strategy.detached, true, "the resident's manager was closed");
      assert.equal(store.isClosed(), false, "the host's store is open");
    } finally {
      if (!store.isClosed()) store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
