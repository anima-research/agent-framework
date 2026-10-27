import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Membrane, MockAdapter, NativeFormatter, rateLimitError } from '@animalabs/membrane';
import type { ProviderRequest, ProviderRequestOptions, StreamCallbacks } from '@animalabs/membrane';
import { AgentFramework, AutobiographicalStrategy } from '../src/index.js';
import type { EventResponse, HostModeStatus, Module, ProcessEvent, ProviderHold, TraceEvent } from '../src/index.js';

const QUOTA = "This request would exceed your account's rate limit.";
const ACCELERATION = "This request would exceed your organization's rate limit acceleration limit.";

class Provider extends MockAdapter {
  compression?: { message: string; retryAfterMs: number };
  primary?: { message: string; retryAfterMs: number };
  override async complete(request: ProviderRequest, options?: ProviderRequestOptions) {
    if (this.compression) throw rateLimitError(this.compression.message, this.compression.retryAfterMs);
    return super.complete(request, options);
  }
  override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions) {
    if (this.primary) throw rateLimitError(this.primary.message, this.primary.retryAfterMs);
    return super.stream(request, callbacks, options);
  }
}

class Texts implements Module {
  readonly name = 'texts';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'user', content: [{ type: 'text', text: String(event.content) }] }],
      requestInference: true,
    };
  }
}

async function host(t: { after(fn: () => Promise<void>): void }, opts: { compressionModel: string; providerHold?: (error: Error) => ProviderHold | undefined }) {
  const dir = mkdtempSync(join(tmpdir(), 'af-held-wakes-'));
  const provider = new Provider({ completeDelayMs: 1, streamChunkDelayMs: 1 });
  // A stated wait past membrane's one-minute ceiling reaches the framework at once, unretried.
  const membrane = new Membrane(provider, { formatter: new NativeFormatter(), retry: { maxRetries: 0, retryDelayMs: 10 } });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane,
    agents: [{
      name: 'resident', model: 'test-model', systemPrompt: 'system',
      strategy: new AutobiographicalStrategy({
        compressionModel: opts.compressionModel, targetChunkTokens: 50, headWindowTokens: 0, recentWindowTokens: 0,
        autoTickOnNewMessage: true, minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
      }),
    }],
    modules: [new Texts()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    ...(opts.providerHold ? { providerHold: opts.providerHold } : {}),
  });
  const traces: string[] = [];
  framework.onTrace((event: TraceEvent) => { traces.push(event.type); });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  framework.start();
  t.after(async () => {
    await framework.stop();
    console.error = original;
    rmSync(dir, { recursive: true, force: true });
  });
  const status = (): HostModeStatus => framework.getHostModeStatus();
  const until = async (what: string, done: () => boolean, boundMs = 5_000): Promise<void> => {
    const end = Date.now() + boundMs;
    while (!done()) {
      if (Date.now() > end) assert.fail(`${what}: not within ${boundMs} ms; status ${JSON.stringify(status())}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const text = (content: string): void => {
    framework.pushEvent({ type: 'external-message', source: 'test', content, metadata: {} });
  };
  const compress = (): void => {
    const cm = framework.getAgent('resident')!.getContextManager();
    for (let i = 0; i < 30; i++) {
      cm.addMessage(i % 2 === 0 ? 'user' : 'resident', [{ type: 'text', text: `message ${i}: ${'word '.repeat(30)}` }]);
    }
  };
  const started = (): number => traces.filter((type) => type === 'inference:started').length;
  return { framework, provider, status, until, text, compress, started, logged };
}

test("a text whose wake a host hold from a failed compression keeps counts in gatedRequests until its turn starts, and drained stays true", async (t) => {
  let spent = true;
  const h = await host(t, {
    compressionModel: 'test-compression-model',
    providerHold: (error) => ((error as { type?: unknown }).type === 'rate_limit' && spent ? { holdMs: 500, reason: 'subscription quota spent' } : undefined),
  });
  h.provider.compression = { message: QUOTA, retryAfterMs: 90_000 };
  h.compress();
  await h.until('the host hold from the compression failure', () => h.logged.some((line) => /host hold \(subscription quota spent\) from an auxiliary call/.test(line)));
  h.text('hello while the quota is spent');
  await h.until('the held wake counted', () => h.status().gatedRequests === 1);
  assert.equal(h.status().drained, true);
  assert.equal(h.status().activeTurns, 0);
  assert.equal(h.started(), 0, 'no turn has started');
  spent = false;
  h.provider.compression = undefined;
  await h.until('the turn the hold kept', () => h.started() === 1);
  await h.until('nothing waiting once it has run', () => h.status().gatedRequests === 0 && h.status().drained);
});

test("a text whose wake a provider's stated wait holds, recorded by a failed compression on the agent's own model, counts in gatedRequests, and drained stays true", async (t) => {
  const h = await host(t, { compressionModel: 'test-model' });
  h.provider.compression = { message: QUOTA, retryAfterMs: 61_000 };
  h.compress();
  await h.until('the wait the compression recorded', () => h.logged.some((line) => /\[provider-wait\] agent=resident model=test-model holds until/.test(line)));
  h.text('hello while the wait binds');
  await h.until('the held wake counted', () => h.status().gatedRequests === 1);
  assert.equal(h.status().drained, true);
  assert.equal(h.status().activeTurns, 0);
  assert.equal(h.started(), 0, 'no turn has started');
});

test('a text whose wake a hold keeps after a stop dropped its turn\'s retry counts in gatedRequests, and drained stays true', async (t) => {
  const h = await host(t, { compressionModel: 'test-compression-model' });
  h.provider.primary = { message: ACCELERATION, retryAfterMs: 61_000 };
  h.text('the turn that fails into an acceleration hold');
  await h.until('the acceleration hold keeping the turn for its retry', () => h.logged.some((line) => /\[provider-cooldown\] agent=resident organization acceleration 429 .* 1 request\(s\) retained/.test(line)));
  assert.equal(h.status().activeTurns, 1, 'the held retry is the turn');
  assert.equal(h.status().drained, false);
  assert.equal(h.framework.abortInference('resident', 'stopped by its caller'), true);
  await h.until('the turn ended', () => h.status().activeTurns === 0);
  h.text('a text after the stop');
  await h.until('the held wake counted', () => h.status().gatedRequests === 1);
  assert.equal(h.status().drained, true);
  assert.equal(h.status().activeTurns, 0);
  assert.equal(h.started(), 1, 'no turn has started since the stop');
});

test("a text whose wake an acceleration hold keeps beside a turn's retry counts in gatedRequests, and the retry still counts as the turn", async (t) => {
  const h = await host(t, { compressionModel: 'test-compression-model' });
  h.provider.primary = { message: ACCELERATION, retryAfterMs: 61_000 };
  h.text('the turn that fails into an acceleration hold');
  await h.until('the acceleration hold keeping the turn for its retry', () => h.logged.some((line) => /\[provider-cooldown\] agent=resident organization acceleration 429 .* 1 request\(s\) retained/.test(line)));
  assert.equal(h.status().activeTurns, 1, 'the held retry is the turn');
  assert.equal(h.status().drained, false);
  assert.equal(h.status().gatedRequests, 0, 'the retry is the turn, not a waiting request');
  h.text('a text during the hold');
  await h.until('the arrival counted', () => h.status().gatedRequests === 1);
  assert.equal(h.status().drained, false);
  assert.equal(h.status().activeTurns, 1);
  assert.deepEqual(h.status().activeTurnAgents, ['resident']);
  assert.equal(h.started(), 1, 'no turn has started since the failure');
});

test("a wake in a scheduler pass's hands, while the pass awaits another agent's start, counts in gatedRequests", async (t) => {
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let alphaWaiting = false;
  const hook = {
    name: 'hook',
    async start() {},
    async stop() {},
    getTools: () => [],
    async handleToolCall() { return { success: false, error: 'no tools' }; },
    async onProcess() { return {}; },
    async gatherContext(agentName: string) {
      if (agentName === 'alpha') { alphaWaiting = true; await blocked; }
      return [];
    },
  } as unknown as Module;
  const dir = mkdtempSync(join(tmpdir(), 'af-held-wakes-pass-'));
  const membrane = new Membrane(new Provider({ completeDelayMs: 1, streamChunkDelayMs: 1 }), { formatter: new NativeFormatter(), retry: { maxRetries: 0, retryDelayMs: 10 } });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane,
    agents: [{ name: 'alpha', model: 'test-model', systemPrompt: 'alpha' }, { name: 'beta', model: 'test-model', systemPrompt: 'beta' }],
    modules: [hook], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const started: string[] = [];
  framework.onTrace((event: TraceEvent) => { if (event.type === 'inference:started') started.push(event.agentName); });
  framework.start();
  t.after(async () => {
    unblock();
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  framework.nudgeAgent('alpha');
  framework.nudgeAgent('beta');
  const end = Date.now() + 5_000;
  while (!alphaWaiting) {
    if (Date.now() > end) assert.fail("alpha's start never waited in its hook");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const status = framework.getHostModeStatus();
  assert.equal(status.gatedRequests, 1, "beta's wake waits in the pass's hands");
  assert.deepEqual(status.activeTurnAgents, ['alpha']);
  unblock();
  const after = Date.now() + 5_000;
  while (!(started.includes('beta') && framework.getHostModeStatus().gatedRequests === 0)) {
    if (Date.now() > after) assert.fail(`beta's turn never started: ${JSON.stringify(framework.getHostModeStatus())}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});
