/**
 * AgentConfig.compressionMembrane: a resident's memory writes on another
 * provider or credential than the framework's membrane.
 *
 * The routing tests need a context manager with `compressionMembrane`, and
 * skip on one without; the refusal test runs only on one without.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { MembraneError } from '@animalabs/membrane';
import { ContextManager } from '@animalabs/context-manager';
import { AgentFramework, AutobiographicalStrategy } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolDefinition, ToolResult } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

const supported = typeof (ContextManager.prototype as { getCompressionMembrane?: unknown }).getCompressionMembrane === 'function';

class Quiet implements Module {
  readonly name = 'test';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: true }; }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
}

/** Answers every compression call, or fails it with a stated wait. */
class Summarizer extends MockMembrane {
  readonly requests: NormalizedRequest[] = [];
  fail = false;
  override async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.requests.push(request);
    if (this.fail) {
      throw new MembraneError({
        type: 'rate_limit', retryable: true, retryAfterMs: 60_000, httpStatus: 429,
        message: 'compression credential: rate limited',
      } as never);
    }
    return createMockResponse([{ type: 'text', text: `Summary ${this.requests.length}: the exchange went on.` }]);
  }
}

function strategy() {
  return new AutobiographicalStrategy({
    compressionModel: 'test-model', targetChunkTokens: 50, headWindowTokens: 0,
    recentWindowTokens: 0, autoTickOnNewMessage: true, minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
  });
}

async function setup(compression: MockMembrane) {
  const dir = mkdtempSync(join(tmpdir(), 'af-compression-membrane-'));
  const primary = new MockMembrane();
  try {
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: primary.asMembrane(),
      agents: [{
        name: 'trunk', model: 'test-model', systemPrompt: 'test', strategy: strategy(),
        compressionMembrane: compression.asMembrane(),
      }],
      modules: [new Quiet()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    return { dir, framework, primary };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function addBacklog(framework: AgentFramework, count: number): void {
  const cm = framework.getAgent('trunk')!.getContextManager();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(cm.addMessage(i % 2 === 0 ? 'user' : 'trunk', [{ type: 'text', text: `message ${i}: ` + 'word '.repeat(30) }]));
  }
  // A resident's strategy reads the rows its window holds.
  cm.presentRows(ids as never[]);
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('AgentConfig.compressionMembrane', () => {
  it('memory writes go to the compression membrane, none to the framework\'s', { skip: !supported, timeout: 60_000 }, async () => {
    const compression = new Summarizer();
    const { dir, framework, primary } = await setup(compression);
    try {
      addBacklog(framework, 20);
      await until(() => compression.requests.length >= 2);
      assert.equal(primary.calls.length, 0, 'the framework\'s membrane carried no memory write');
      assert.ok(compression.requests.every((r) => r.config.model === 'test-model'));
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failure on the compression membrane holds nothing on the agent\'s own provider', { skip: !supported, timeout: 60_000 }, async () => {
    const compression = new Summarizer();
    compression.fail = true;
    const { dir, framework, primary } = await setup(compression);
    try {
      addBacklog(framework, 20);
      await until(() => compression.requests.length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(framework.providerWaitSnapshot('trunk'), [], 'no provider wait recorded for the agent\'s model');
      const cooldowns = (framework as unknown as { providerAccelerationCooldowns: Map<string, unknown> }).providerAccelerationCooldowns;
      assert.equal(cooldowns.has('trunk'), false, 'no provider hold armed for the agent');
      assert.equal(primary.calls.length, 0);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a context manager without compressionMembrane: createAgent refuses rather than compress on the agent\'s provider', { skip: supported }, async () => {
    await assert.rejects(setup(new Summarizer()), /compressionMembrane needs an @animalabs\/context-manager/);
  });
});
