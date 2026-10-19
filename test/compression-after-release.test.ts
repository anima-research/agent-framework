/**
 * A context manager the framework is done with makes no provider call
 * (anima-research/agent-framework#550): an ephemeral agent's compression is
 * withdrawn unsent once its run has left or cleanup() has released it, and a
 * conversation fork's once it has been disposed. An ephemeral agent's is
 * withdrawn too, as every agent's is, under a surgery's hold and once stop()
 * has begun. The withdrawal is context-manager's CompressionWithdrawn, so the
 * strategy's drain stops quietly and logs nothing.
 *
 * Each test gives the manager an autobiographical strategy that drains in the
 * background (autoTickOnNewMessage), as connectome-host builds a subagent's,
 * and a backlog of small chunks, so its drain still has compression queued at
 * the moment under test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, AutobiographicalStrategy } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

/** Compression calls (complete()) are recorded when they reach the provider,
 *  and answer after `delayMs`; inference (streamYielding) is MockMembrane's. */
class CompressionMembrane extends MockMembrane {
  readonly compressions: number[] = [];
  inFlight = 0;
  constructor(private readonly delayMs: number) { super(); }
  override async complete(_request: NormalizedRequest): Promise<NormalizedResponse> {
    this.compressions.push(Date.now());
    this.inFlight++;
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    } finally {
      this.inFlight--;
    }
    return createMockResponse([{ type: 'text', text: `Summary ${this.compressions.length}: the exchange went on.` }]);
  }
  since(at: number): number {
    return this.compressions.filter((started) => started > at).length;
  }
}

/** Before a test stops its framework: let a compression still out return, and
 *  its drain take the next tick, which a released manager's withdrawal ends.
 *  A drain tick still scheduled when the store closes throws from its timer
 *  in context-manager 0.16.0, which would land in a later test. */
async function quiesce(membrane: CompressionMembrane): Promise<void> {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the drain');
    await sleep(5);
  }
}

/** Errors context-manager or the framework log about a withdrawal or a drain. */
function captureDrainErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ');
    if (/withdrawn|Failed to compress|speculative-drain/i.test(text)) lines.push(text);
  };
  return { lines, restore: () => { console.error = original; } };
}

async function setup(prefix: string, membrane: CompressionMembrane, stopMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(), agents: [],
    modules: [new Quiet(stopMs)], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  return { dir, framework };
}

function drainingStrategy() {
  return new AutobiographicalStrategy({
    compressionModel: 'test-compression-model', targetChunkTokens: 50, headWindowTokens: 0,
    recentWindowTokens: 0, autoTickOnNewMessage: true, minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
  });
}

async function createDraining(framework: AgentFramework, name = 'worker') {
  return framework.createEphemeralAgent({
    name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', strategy: drainingStrategy(),
  });
}

/** Adds `count` messages, each about a chunk's worth, so the drain queues one
 *  chunk after another. */
function addBacklog(contextManager: { addMessage: Awaited<ReturnType<typeof createDraining>>['contextManager']['addMessage'] }, count: number, from = 0): void {
  for (let i = from; i < from + count; i++) {
    contextManager.addMessage(i % 2 === 0 ? 'user' : 'worker', [{ type: 'text', text: `message ${i}: ` + 'word '.repeat(30) }]);
  }
}

describe('a context manager the framework is done with makes no compression call (#550)', () => {
  it('once its run has ended, with compression still queued', { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(200);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const { dir, framework } = await setup('af-ephemeral-withdrawn-run-', membrane);
    const errors = captureDrainErrors();
    try {
      const { agent, contextManager } = await createDraining(framework);
      addBacklog(contextManager, 30);
      contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      await until(() => membrane.compressions.length >= 1);
      const run = framework.runEphemeralToCompletion(agent, contextManager);
      framework.start();
      await run;
      const ended = Date.now();
      await sleep(1_000);
      assert.equal(membrane.since(ended), 0, 'no compression call reached the provider after the run ended');
      assert.deepEqual(errors.lines, [], 'the withdrawal stopped the drain without a log line');
    } finally {
      errors.restore();
      await quiesce(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('once cleanup() has released it without a run, and only its own manager', { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(100);
    const { dir, framework } = await setup('af-ephemeral-withdrawn-cleanup-', membrane);
    const errors = captureDrainErrors();
    try {
      const released = await createDraining(framework, 'released');
      addBacklog(released.contextManager, 30);
      await until(() => membrane.compressions.length >= 1);
      released.cleanup();
      const at = Date.now();
      await sleep(800);
      assert.equal(membrane.since(at), 0, "no compression call reached the provider after the manager's release");
      // A manager created after another's release compresses as before.
      const other = await createDraining(framework, 'other');
      const before = Date.now();
      addBacklog(other.contextManager, 6);
      await until(() => membrane.since(before) >= 1);
      other.cleanup();
      await quiesce(membrane);
      assert.deepEqual(errors.lines, [], 'the withdrawal stopped the drain without a log line');
    } finally {
      errors.restore();
      await quiesce(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('once stop() has begun, while stop() is still tearing down', { timeout: 60_000 }, async () => {
    // A module's stop() keeps stop() running 300 ms, while the drain has a
    // backlog it would work through at one call per 50 ms.
    const membrane = new CompressionMembrane(50);
    const { dir, framework } = await setup('af-ephemeral-withdrawn-stop-', membrane, 300);
    const errors = captureDrainErrors();
    try {
      framework.start();
      const { contextManager, cleanup } = await createDraining(framework);
      addBacklog(contextManager, 40);
      await until(() => membrane.compressions.length >= 1);
      const stopping = Date.now();
      await framework.stop();
      await sleep(300);
      assert.equal(membrane.since(stopping), 0, 'no compression call reached the provider once stop() had begun');
      assert.deepEqual(errors.lines.filter((line) => /withdrawn|Failed to compress/i.test(line)), [],
        'the withdrawal stopped the drain without a log line');
      cleanup();
    } finally {
      errors.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('once its conversation fork has been disposed, with compression still queued', { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(100);
    const dir = mkdtempSync(join(tmpdir(), 'af-fork-withdrawn-dispose-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
      agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'test' }],
      modules: [new Quiet()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      conversations: { templateAgent: 'trunk', bind: { channel: 'mention' }, strategyFactory: () => drainingStrategy() },
    });
    const internals = framework as unknown as {
      createConversationAgent(name: string, channelId: string): Promise<unknown>;
      disposeConversationAgent(name: string): void;
    };
    const errors = captureDrainErrors();
    try {
      await internals.createConversationAgent('trunk-chan-g1', 'world:chan');
      addBacklog(framework.getAgent('trunk-chan-g1')!.getContextManager(), 30);
      await until(() => membrane.compressions.length >= 1);
      internals.disposeConversationAgent('trunk-chan-g1');
      const at = Date.now();
      await sleep(800);
      assert.equal(membrane.since(at), 0, 'no compression call reached the provider after the fork was disposed');
      assert.deepEqual(errors.lines, [], 'the withdrawal stopped the drain without a log line');
    } finally {
      errors.restore();
      await quiesce(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("while a surgery holds the store, and again once the hold is released", { timeout: 60_000 }, async () => {
    const membrane = new CompressionMembrane(20);
    const { dir, framework } = await setup('af-ephemeral-withdrawn-surgery-', membrane);
    const internals = framework as unknown as { reserveStoreForSurgery(verb: string, agentName: string): () => void };
    const errors = captureDrainErrors();
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
      // The next message starts the drain again, and its calls go out.
      addBacklog(contextManager, 2, 12);
      await until(() => membrane.compressions.length >= 1);
      cleanup();
      await quiesce(membrane);
      assert.deepEqual(errors.lines, [], 'the withdrawal stopped the drain without a log line');
    } finally {
      errors.restore();
      await quiesce(membrane);
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
