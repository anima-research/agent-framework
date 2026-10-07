/**
 * Provider waits: a provider's stated retry-after is a lower bound on the next
 * call to that model, for that agent, across restarts and branch switches.
 *
 * Unit cases drive ProviderWaits on a real Chronicle store; framework cases
 * drive a real AgentFramework whose membrane answers with classified errors
 * carrying retryAfterMs.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { ProviderWaits, waitDeadline, PROVIDER_WAIT_RECORD_TYPE } from '../src/provider-waits.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

function withStoreDir<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'provider-waits-'));
  return Promise.resolve(fn(join(dir, 'store'))).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A clock tests can move. */
function clock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

const quiet = { log: () => {} };

describe('waitDeadline', () => {
  it('is the absolute instant of a usable wait', () => {
    assert.equal(waitDeadline(1_500, 1_000), 2_500);
    assert.equal(waitDeadline(0, 1_000), 1_000);
    assert.equal(waitDeadline(0.4, 1_000), 1_001, 'rounded up, never down');
  });

  it('is null (held until released) for a wait it cannot represent', () => {
    for (const unusable of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1e20, '60', undefined]) {
      assert.equal(waitDeadline(unusable, 1_000), null, String(unusable));
    }
    assert.equal(waitDeadline(8.64e15 - 1_000, 1_000), 8.64e15, 'the last representable instant');
    assert.equal(waitDeadline(8.64e15, 1_000), null, 'one past it');
  });
});

describe('ProviderWaits', () => {
  it('binds (agent, model) until the wait passes', () => withStoreDir((path) => {
    const store = JsStore.openOrCreate({ path });
    try {
      const time = clock();
      const waits = new ProviderWaits(store, { now: time.now, ...quiet });
      waits.set('ada', 'zz-model', 60_000, 'zz 429');
      assert.equal(waits.active('ada', 'zz-model')?.until, time.now() + 60_000);
      assert.equal(waits.active('ada', 'zz-other'), undefined, 'another model is not bound');
      assert.equal(waits.active('bo', 'zz-model'), undefined, 'another agent is not bound');
      time.advance(59_999);
      assert.ok(waits.active('ada', 'zz-model'));
      time.advance(1);
      assert.equal(waits.active('ada', 'zz-model'), undefined);
    } finally { store.close(); }
  }));

  it('never lets a later, shorter wait shorten an outstanding one; indefinite stays indefinite', () => withStoreDir((path) => {
    const store = JsStore.openOrCreate({ path });
    try {
      const time = clock();
      const waits = new ProviderWaits(store, { now: time.now, ...quiet });
      const long = waits.set('ada', 'zz-model', 600_000, 'long');
      assert.equal(long.changed, true);
      const short = waits.set('ada', 'zz-model', 10_000, 'short');
      assert.equal(short.changed, false);
      assert.equal(short.wait.until, time.now() + 600_000);
      assert.equal(short.wait.reason, 'long');
      const longer = waits.set('ada', 'zz-model', 900_000, 'longer');
      assert.equal(longer.changed, true);
      assert.equal(waits.active('ada', 'zz-model')?.until, time.now() + 900_000);

      waits.set('ada', 'zz-model', Number.NaN, 'unusable');
      assert.equal(waits.active('ada', 'zz-model')?.until, null);
      waits.set('ada', 'zz-model', 5_000, 'finite after indefinite');
      assert.equal(waits.active('ada', 'zz-model')?.until, null);
      time.advance(10 * 365 * 24 * 3_600_000);
      assert.equal(waits.active('ada', 'zz-model')?.until, null, 'an indefinite wait does not pass');
    } finally { store.close(); }
  }));

  it('survives a reopen, a checkpoint and a branch switch, with the same lower bound', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const waits = new ProviderWaits(store, { now: time.now, ...quiet });
      waits.set('ada', 'zz-model', 600_000, 'long');
      waits.set('ada', 'zz-forever', Number.POSITIVE_INFINITY, 'unusable');
      // Enough entries to force a checkpoint, then shorter hints after it.
      for (let i = 0; i < 70; i++) waits.set(`agent-${i}`, 'zz-model', 1_000 + i, `hint ${i}`);
      waits.set('ada', 'zz-model', 10_000, 'short, after the checkpoint');
      waits.set('ada', 'zz-forever', 10_000, 'finite, after the checkpoint');
      assert.ok(store.getRecordIdsByType(`${PROVIDER_WAIT_RECORD_TYPE}/checkpoint`).length >= 1, 'a checkpoint was written');

      // A rollback-shaped branch switch: back before every wait was recorded.
      const main = store.currentBranch().name;
      store.createBranchAt('rollback', main, 0);
      store.switchBranch('rollback');
      store.close();

      store = JsStore.openOrCreate({ path });
      assert.equal(store.currentBranch().name, 'rollback');
      const reopened = new ProviderWaits(store, { now: time.now, ...quiet });
      assert.equal(reopened.active('ada', 'zz-model')?.until, time.now() + 600_000, 'the longer wait still binds');
      assert.equal(reopened.active('ada', 'zz-model')?.reason, 'long');
      assert.equal(reopened.active('ada', 'zz-forever')?.until, null, 'the indefinite wait still binds');
      reopened.set('ada', 'zz-model', 20_000, 'shorter again');
      assert.equal(reopened.active('ada', 'zz-model')?.until, time.now() + 600_000);
    } finally { if (!store.isClosed()) store.close(); }
  }));

  it('a recorded release outlives a reopen; releasing one model leaves the others', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const waits = new ProviderWaits(store, { now: time.now, ...quiet });
      waits.set('ada', 'zz-a', 600_000, 'a');
      waits.set('ada', 'zz-b', 600_000, 'b');
      waits.set('bo', 'zz-a', 600_000, 'bo');
      assert.deepEqual(waits.release('ada', 'zz-a', 'operator').map((w) => w.model), ['zz-a']);
      assert.equal(waits.active('ada', 'zz-a'), undefined);
      assert.ok(waits.active('ada', 'zz-b'));
      store.close();

      store = JsStore.openOrCreate({ path });
      const reopened = new ProviderWaits(store, { now: time.now, ...quiet });
      assert.equal(reopened.active('ada', 'zz-a'), undefined, 'released stays released');
      assert.ok(reopened.active('ada', 'zz-b'));
      assert.deepEqual(reopened.release('ada', undefined, 'operator').map((w) => w.model), ['zz-b']);
      assert.ok(reopened.active('bo', 'zz-a'), "another agent's wait is untouched");
      assert.deepEqual(reopened.release('ada', undefined, 'operator'), [], 'nothing left to release');
    } finally { if (!store.isClosed()) store.close(); }
  }));
});

// ---------------------------------------------------------------------------
// The framework: a real store, context manager and admission.
// ---------------------------------------------------------------------------

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

const rateLimited = (retryAfterMs: number | undefined, request?: NormalizedRequest) => new MembraneError({
  type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs,
  message: 'zz rate limit reached for requests', rawError: { status: 429 }, rawRequest: request,
});

/** Primary turns fail with a stated wait `failures` times, then succeed. */
class WaitingMembrane extends MockMembrane {
  primary = 0;
  auxiliary: NormalizedRequest[] = [];
  auxiliaryFailure: Error | undefined;
  constructor(private failures: number, private readonly retryAfterMs: number | undefined) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    this.primary++;
    if (this.primary <= this.failures) return new ErrorStream(rateLimited(this.retryAfterMs, request));
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'zz-recovered' }])]);
  }
  override async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.auxiliary.push(request);
    if (this.auxiliaryFailure) throw this.auxiliaryFailure;
    return createMockResponse([{ type: 'text', text: 'zz-summary' }]);
  }
}

type Internal = {
  consecutiveInferenceFailures: Map<string, number>;
  providerAccelerationCooldowns: Map<string, { until: number; waitModel?: string; heldRequests: unknown[] }>;
  auxiliaryMembraneFor(agentName: string): { complete(request: unknown): Promise<unknown> };
  handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
};

async function framework(path: string, membrane: WaitingMembrane) {
  const fw = await AgentFramework.create({
    storePath: path, membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  return { fw, internal: fw as unknown as Internal };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const auxRequest = (model: string) => ({
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-compress' }] }],
  config: { model, maxTokens: 16 },
});

function silence() {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.error = orig; } };
}

test('a primary 429 with retry-after holds the turn, without a failure marker, and resumes once after it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 400);
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'no retry inside the wait');
      assert.equal(internal.consecutiveInferenceFailures.get('resident') ?? 0, 0, 'capacity is not a failure streak');
      const health = fw.healthSnapshot() as { agents: Array<{ providerAdmission: { providerWaits: Array<{ model: string; until: string | null }> } }> };
      assert.equal(health.agents[0].providerAdmission.providerWaits[0].model, 'zz-model');

      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-arrived while waiting', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'an arrival during the wait is held, not inferred');

      await sleep(550);
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 2, 'one fresh compile after the wait');
      const text = membrane.calls[1].messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
      assert.match(text, /zz-first/);
      assert.match(text, /zz-arrived while waiting/);
      const markers = fw.getAgent('resident')!.getContextManager().queryMessages({}).messages
        .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'inference-failed');
      assert.equal(markers.length, 0);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a stated wait past the framework cap is honoured in full, until an operator releases it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const twentyMinutes = 20 * 60_000;
    const membrane = new WaitingMembrane(1, twentyMinutes);
    const { fw, internal } = await framework(path, membrane);
    try {
      const before = Date.now();
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const cooldown = internal.providerAccelerationCooldowns.get('resident')!;
      assert.ok(cooldown.until >= before + twentyMinutes, 'not shortened to the 10-minute cap');
      assert.equal(cooldown.waitModel, 'zz-model');

      const released = await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'resident', model: 'zz-model', requesterName: 'zz-operator' });
      assert.equal(released.ok, true);
      assert.deepEqual((released.released as Array<{ model: string }>).map((w) => w.model), ['zz-model']);
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 2, 'the held turn runs once released');
      assert.ok(log.lines.some((l) => l.includes('released by zz-operator')));
    } finally { await fw.stop(); log.restore(); }
  });
});

test('auxiliary admission: the same model is refused without a call; another model proceeds', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 60_000);
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const aux = internal.auxiliaryMembraneFor('resident');
      const refused = await aux.complete(auxRequest('zz-model')).then(() => undefined, (e: unknown) => e);
      assert.ok(refused instanceof MembraneError);
      assert.equal(refused.type, 'rate_limit');
      assert.ok(refused.retryAfterMs !== undefined && refused.retryAfterMs > 50_000 && refused.retryAfterMs <= 60_000);
      assert.match(refused.message, /no call was made/);
      assert.equal(membrane.auxiliary.length, 0, 'the provider was not called');

      await aux.complete(auxRequest('zz-compression-model'));
      assert.equal(membrane.auxiliary.length, 1, 'a model the provider did not limit keeps working');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an auxiliary call's stated wait binds that model only", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(0, undefined);
    membrane.auxiliaryFailure = rateLimited(60_000);
    const { fw, internal } = await framework(path, membrane);
    try {
      const aux = internal.auxiliaryMembraneFor('resident');
      await assert.rejects(aux.complete(auxRequest('zz-compression-model')), /zz rate limit/);
      membrane.auxiliaryFailure = undefined;
      await assert.rejects(aux.complete(auxRequest('zz-compression-model')), /Provider wait/);
      assert.equal(membrane.auxiliary.length, 1, 'the second call never reached the provider');

      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-turn', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'the primary model is not bound by the compression model wait');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a restart honours the wait, even after a switch to a branch from before it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 60_000);
    let opened = await framework(path, membrane);
    try {
      opened.fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await opened.fw.runUntilIdle();
      assert.equal(membrane.primary, 1);
    } finally { await opened.fw.stop(); }

    // Roll the store back to before the wait existed, then restart on it.
    const store = JsStore.openOrCreate({ path });
    const main = store.currentBranch().name;
    store.createBranchAt('zz-rollback', main, 0);
    store.switchBranch('zz-rollback');
    store.close();

    opened = await framework(path, membrane);
    try {
      opened.fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-after restart', metadata: {} });
      await opened.fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'no call before the provider said');
      const waits = opened.fw.providerWaitSnapshot('resident');
      assert.equal(waits.length, 1);
      assert.equal(waits[0].model, 'zz-model');

      opened.fw.releaseProviderWait('resident');
      await opened.fw.runUntilIdle();
      assert.equal(membrane.primary, 2, 'released by the operator, the held turn runs');
    } finally { await opened.fw.stop(); log.restore(); }
  });
});

test('a retry policy delay past one timer is waited in full, and stop() ends the wait', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    // A non-membrane error keeps provider admission out of it: only the policy decides.
    class ThrowingMembrane extends WaitingMembrane {
      override streamYielding(request: NormalizedRequest): YieldingStream {
        this.calls.push(request); this.primary++;
        return new ErrorStream(new Error('zz transient'));
      }
    }
    const membrane = new ThrowingMembrane(0, undefined);
    const fw = await AgentFramework.create({
      storePath: path, membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
      modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      errorPolicy: {
        maxRetries: 2,
        onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt < 2 ? { retry: true, delayMs: 3_000_000_000 } : { retry: false }),
      },
    });
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      void fw.runUntilIdle();
      await sleep(300);
      assert.equal(membrane.primary, 1, 'a 34-day delay does not fire almost at once');
    } finally {
      const stopping = fw.stop();
      await Promise.race([stopping, sleep(5_000).then(() => { throw new Error('stop() did not end the wait'); })]);
      log.restore();
    }
  });
});
