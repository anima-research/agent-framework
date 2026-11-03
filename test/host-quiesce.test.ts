/**
 * Host quiesce/maintenance mode (issue #122) — deterministic state-machine
 * coverage, plus an end-to-end MCPL leg with a child server and crash cases
 * whose crash a child process stages (both below).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ContextStrategy,
  StrategyContext,
  ReadinessState,
  MessageStoreView,
  ContextLogView,
  TokenBudget,
  ContextEntry,
} from '@animalabs/context-manager';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import type { StreamEvent, YieldingStream, NormalizedRequest } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';

import { AgentFramework, ResumeBlockedError } from '../src/index.js';
import { setAbandonGraceForTests } from '../src/framework.js';
import type { TraceEvent } from '../src/types/trace.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { schedulerPasses } from './helpers/scheduler-passes.js';
import { jsonLines } from './helpers/json-lines.js';

async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function autobiographical(): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    recentWindowTokens: 30_000,
    kvStableReachTokens: 8_000,
  });
}

function stubPreview(
  framework: AgentFramework,
  agentName: string,
  impl: (budget: { maxTokens: number }) => Record<string, unknown>,
): void {
  const cm = framework.getAgent(agentName)!.getContextManager() as unknown as {
    previewContext?: (budget: { maxTokens: number }) => unknown;
  };
  cm.previewContext = (budget) => impl(budget);
}

async function withFramework(
  membrane: MockMembrane,
  fn: (framework: AgentFramework, dir: string) => Promise<void>,
  agentExtras: Record<string, unknown> = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      ...agentExtras,
    }],
    modules: [],
  });
  try {
    await fn(framework, dir);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('quiesce parks wakes; resume releases them', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    framework.start();
    const before = await framework.quiesce({ reason: 'test window' });
    assert.equal(before.quiesced, true);
    assert.equal(before.drained, true);
    const nextPass = schedulerPasses(framework, waitFor);

    const nudge = framework.nudgeAgent('agent', 'operator');
    assert.equal(nudge.ok, true);
    // A pass over the nudge's wake, which would have started its turn.
    await nextPass();
    assert.equal(membrane.calls.length, 0, 'no inference while quiesced');
    assert.equal(framework.getAgent('agent')!.state.status, 'idle');
    assert.equal(framework.getHostModeStatus().gatedRequests, 1);

    const after = await framework.resume();
    assert.equal(after.quiesced, false);
    await waitFor('parked wake to fire', () => membrane.calls.length > 0);
  });
});

test('parked wakes coalesce per (agent, reason), keeping the set bounded', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    framework.start();
    await framework.quiesce();
    const nextPass = schedulerPasses(framework, waitFor);
    for (let i = 0; i < 5; i++) framework.nudgeAgent('agent', 'operator');
    // The loop's next pass compresses same-reason parked requests to one.
    await waitFor(
      'coalescing to a single parked request',
      () => framework.getHostModeStatus().gatedRequests === 1,
    );
    // A later pass over the coalesced request, which would have started it.
    await nextPass();
    assert.equal(framework.getHostModeStatus().gatedRequests, 1, 'stays bounded');
    assert.equal(membrane.calls.length, 0);
  });
});

test('coalescing keeps an ADDRESSED wake alive when an ambient one of the same reason parks later', async () => {
  // Every channel wake shares one reason; keying the coalescer on reason
  // alone let an ambient message parked later evict a DM/mention parked
  // earlier — and the resumed turn then answered into the ambient channel.
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    framework.start();
    await framework.quiesce();
    const nextPass = schedulerPasses(framework, waitFor);
    // Re-read on every access: the scheduler REASSIGNS pendingRequests
    // when it takes a batch, so a captured reference goes stale.
    const pending = () => (framework as unknown as { pendingRequests: Array<Record<string, unknown>> }).pendingRequests;
    const t = Date.now();
    pending().push(
      { agentName: 'agent', reason: 'mcpl:channel-incoming', source: 'framework', timestamp: t, addressed: true, channelId: 'dm' },
      { agentName: 'agent', reason: 'mcpl:channel-incoming', source: 'framework', timestamp: t + 1, addressed: false, channelId: 'lounge' },
      { agentName: 'agent', reason: 'mcpl:channel-incoming', source: 'framework', timestamp: t + 2, addressed: false, channelId: 'lounge' },
    );
    await waitFor('scheduler pass to coalesce', () => framework.getHostModeStatus().gatedRequests === 2);
    // A later pass over the survivors, which would have started them.
    await nextPass();
    const survivors = pending().filter((r) => r.reason === 'mcpl:channel-incoming');
    assert.equal(survivors.length, 2, 'one addressed + one ambient survive');
    assert.ok(survivors.some((r) => r.addressed === true && r.channelId === 'dm'), 'the addressed wake survived');
    assert.ok(survivors.some((r) => r.addressed === false && r.timestamp === t + 2), 'the newest ambient wake survived');
    assert.equal(membrane.calls.length, 0);
  });
});

test('runUntilIdle returns with gated requests parked', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    await framework.quiesce();
    framework.nudgeAgent('agent', 'operator');
    // Must not hang: parked requests are not progress while quiesced.
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 0);
  });
});

test('ephemeral admission is refused while quiesced', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    await framework.quiesce({ reason: 'surgery' });
    await assert.rejects(
      // Refused before the agent/CM are touched — a minimal stand-in suffices.
      framework.runEphemeralToCompletion(
        { name: 'ephemeral' } as never,
        {} as never,
      ),
      /quiesced \(surgery\).*resume\(\) first/,
    );
  });
});

/** A stream that never completes until cancelled — models a hung provider. */
class HangingStream implements YieldingStream {
  private pendingResolve: (() => void) | null = null;
  private aborted = false;
  cancel(): void {
    this.aborted = true;
    this.pendingResolve?.();
  }
  protected waitForCancel(): Promise<void> {
    if (this.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => { this.pendingResolve = resolve; });
  }
  provideToolResults(): void {}
  get isWaitingForTools() { return false; }
  get pendingToolCallIds(): string[] { return []; }
  get toolDepth() { return 0; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await this.waitForCancel();
    yield { type: 'aborted', reason: 'user' } as StreamEvent;
  }
}
class HangingMembrane extends MockMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return new HangingStream();
  }
}

test('drain waits for an in-flight turn; abandon cancels without failure accounting', async () => {
  const membrane = new HangingMembrane();
  await withFramework(membrane, async (framework) => {
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('turn to start', () => membrane.calls.length === 1);

    const status = await framework.quiesce({ timeoutMs: 1_000, abandon: true });
    assert.equal(status.quiesced, true);
    assert.equal(status.drained, true, 'abandon settles the hung turn');
    await waitFor('agent back to idle', () =>
      framework.getAgent('agent')!.state.status === 'idle');

    assert.ok(
      traces.some((t) => t.type === 'inference:aborted'
        && (t as { reason?: string }).reason === 'quiesce_abandoned'),
      'abandon is traced as an operator abort',
    );
    assert.ok(
      !traces.some((t) => t.type === 'inference:exhausted'),
      'an operator cancel must not feed the failure streak / hard-down accounting',
    );
    const quiesceTrace = traces.find((t) => t.type === 'host:quiesce') as
      { abandoned?: boolean } | undefined;
    assert.equal(quiesceTrace?.abandoned, true);
  });
});

test('quiesce persists across restart; resume clears it durably', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-persist-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  let framework = await AgentFramework.create(config());
  try {
    await framework.quiesce({ reason: 'refold in progress' });
    await framework.stop();

    framework = await AgentFramework.create(config());
    const restored = framework.getHostModeStatus();
    assert.equal(restored.quiesced, true, 'a restart mid-surgery boots quiesced');
    assert.equal(restored.reason, 'refold in progress');

    await framework.resume();
    await framework.stop();

    framework = await AgentFramework.create(config());
    assert.equal(framework.getHostModeStatus().quiesced, false);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Run `body` while the host-mode record's write fails: the recovery file's,
 *  or framework/state's when there's no recovery file. */
async function withFailingHostModeWrite(body: () => Promise<void>): Promise<void> {
  const framework = AgentFramework.prototype as unknown as { writeRecoveryFile(path: string, document: unknown): void };
  const writeFile = framework.writeRecoveryFile;
  const store = JsStore.prototype as unknown as { setStateJson(this: JsStore, id: string, value: unknown): void };
  const setState = store.setStateJson;
  framework.writeRecoveryFile = function (this: unknown, path: string, document: unknown) {
    if (path.endsWith('host-mode.json')) throw Object.assign(new Error('injected EACCES writing host-mode.json'), { code: 'EACCES' });
    return writeFile.call(this, path, document);
  };
  store.setStateJson = function (this: JsStore, id: string, value: unknown) {
    if (id === 'framework/state' && new Error().stack?.includes('persistHostMode')) throw new Error('injected EIO writing framework/state');
    return setState.call(this, id, value);
  };
  try {
    await body();
  } finally {
    framework.writeRecoveryFile = writeFile;
    store.setStateJson = setState;
  }
}

/** console.error's lines until restore(), kept instead of printed. */
function captureErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.error = original; } };
}

/** Run `body` while the store's sync after a host-mode write fails. */
async function withFailingHostModeSync(body: () => Promise<void>): Promise<void> {
  const store = JsStore.prototype as unknown as { sync(this: JsStore): void };
  const sync = store.sync;
  store.sync = function (this: JsStore) {
    if (new Error().stack?.includes('persistHostMode')) throw new Error('injected EIO syncing the store');
    return sync.call(this);
  };
  try {
    await body();
  } finally {
    store.sync = sync;
  }
}

/** A framework on a recovery file or a store only, with a restart that, store
 *  only, closes the store and opens it again, and the record's quiesced. */
async function hostModeFixture(where: 'recovery file' | 'store only') {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-record-'));
  const storePath = join(dir, 'store');
  let store = where === 'store only' ? JsStore.openOrCreate({ path: storePath }) : undefined;
  const config = () => ({
    ...(store ? { store } : { storePath }),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  const f = { framework: await AgentFramework.create(config()) };
  return {
    get framework() { return f.framework; },
    async restart(): Promise<void> {
      await f.framework.stop();
      if (store) {
        store.close();
        store = JsStore.openOrCreate({ path: storePath });
      }
      f.framework = await AgentFramework.create(config());
    },
    /** The record's quiesced: the recovery file's, or framework/state's hostMode. */
    recorded(): unknown {
      if (store) return (store.getStateJson('framework/state') as { hostMode?: { quiesced?: unknown } } | null)?.hostMode?.quiesced;
      const file = join(storePath, 'recovery', 'host-mode.json');
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { quiesced?: unknown }).quiesced : undefined;
    },
    async close(): Promise<void> {
      await f.framework.stop();
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a quiesce whose host-mode write fails leaves the host serving and its record unchanged, and the next quiesce writes it", async () => {
  for (const where of ['recovery file', 'store only'] as const) {
    const h = await hostModeFixture(where);
    try {
      await withFailingHostModeWrite(async () => {
        await assert.rejects(h.framework.quiesce({ reason: 'surgery' }), {
          message: where === 'store only' ? 'injected EIO writing framework/state' : 'injected EACCES writing host-mode.json',
        });
      });
      const status = h.framework.getHostModeStatus();
      assert.equal(status.quiesced, false, `${where}: the host is still serving`);
      assert.equal(status.reason, undefined, `${where}: no quiesce reason`);
      assert.equal(status.since, undefined, `${where}: no quiesce time`);
      assert.equal(h.recorded(), undefined, `${where}: no record was written`);
      (h.framework as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage('user', [{ type: 'text', text: 'after' }]);
      assert.equal(h.framework.getHostModeStatus().deferredWrites, 0, `${where}: the context write isn't deferred`);
      const texts = h.framework.getAgent('agent')!.getContextManager().getAllMessages()
        .map((m) => (m.content[0] as { text?: string } | undefined)?.text);
      assert.ok(texts.includes('after'), `${where}: the context write lands`);
      await h.restart();
      assert.equal(h.framework.getHostModeStatus().quiesced, false, `${where}: a restart after the failed quiesce boots serving`);
      await h.framework.quiesce({ reason: 'surgery' });
      const since = h.framework.getHostModeStatus().since;
      assert.equal(h.framework.getHostModeStatus().quiesced, true, `${where}: the next quiesce quiesces`);
      assert.equal(h.recorded(), true, `${where}: and writes the record`);
      await h.restart();
      const restored = h.framework.getHostModeStatus();
      assert.equal(restored.quiesced, true, `${where}: a restart then boots quiesced`);
      assert.equal(restored.reason, 'surgery', `${where}: with the reason`);
      assert.equal(restored.since, since, `${where}: and the time it recorded`);
    } finally {
      await h.close();
    }
  }
});

test("a resume whose record clear fails rejects with the record still quiesced, and a retried resume clears it", async () => {
  for (const where of ['recovery file', 'store only'] as const) {
    // Quiesced by this process's quiesce(), or by the record at a quiesced boot.
    for (const booted of [false, true]) {
      const label = `${where}${booted ? ', booted quiesced' : ''}`;
      const h = await hostModeFixture(where);
      try {
        // A resume() that cleared the record leaves nothing to clear: the next
        // resume() on the serving host writes nothing, so a failing write doesn't reach it.
        await h.framework.quiesce({ reason: 'surgery' });
        await h.framework.resume();
        await withFailingHostModeWrite(() => h.framework.resume().then(() => {}));
        await h.framework.quiesce({ reason: 'surgery' });
        if (booted) await h.restart();
        assert.equal(h.framework.getHostModeStatus().quiesced, true, `${label}: quiesced`);
        await withFailingHostModeWrite(async () => {
          await assert.rejects(h.framework.resume(), {
            message: where === 'store only' ? 'injected EIO writing framework/state' : 'injected EACCES writing host-mode.json',
          });
        });
        assert.equal(h.framework.getHostModeStatus().quiesced, false, `${label}: resume() serves before it clears the record`);
        assert.equal(h.recorded(), true, `${label}: the record still says quiesced`);
        // A retry whose clear fails too rejects, and the clear is still owed.
        await withFailingHostModeWrite(async () => {
          await assert.rejects(h.framework.resume(), {
            message: where === 'store only' ? 'injected EIO writing framework/state' : 'injected EACCES writing host-mode.json',
          });
        });
        assert.equal(h.recorded(), true, `${label}: a retry whose clear fails leaves the record quiesced`);
        await h.framework.resume();
        assert.notEqual(h.recorded(), true, `${label}: the next retried resume() clears the record`);
        // Cleared, a resume() on the serving host writes nothing, so a failing write doesn't reach it.
        await withFailingHostModeWrite(() => h.framework.resume().then(() => {}));
        await h.restart();
        assert.equal(h.framework.getHostModeStatus().quiesced, false, `${label}: a restart then boots serving`);
      } finally {
        await h.close();
      }
    }
  }
});

test("a resume() that would clear the record of a serving host waits out a surgery, as resume() does on a quiesced one", async () => {
  for (const where of ['recovery file', 'store only'] as const) {
    const h = await hostModeFixture(where);
    const internals = h.framework as unknown as { surgeryHold: { verb: string; agentName: string; since: number } | null };
    try {
      await h.framework.quiesce({ reason: 'surgery' });
      await withFailingHostModeWrite(async () => {
        await assert.rejects(h.framework.resume());
      });
      assert.equal(h.recorded(), true, `${where}: the record still says quiesced`);
      internals.surgeryHold = { verb: 'rollback', agentName: 'agent', since: Date.now() };
      try {
        await assert.rejects(h.framework.resume(), {
          message: 'Cannot resume: a live rollback for agent holds the store — retry when it completes',
        });
        assert.equal(h.recorded(), true, `${where}: refused, it writes nothing`);
      } finally {
        internals.surgeryHold = null;
      }
      await h.framework.resume();
      assert.notEqual(h.recorded(), true, `${where}: once the surgery is done, resume() clears the record`);
    } finally {
      await h.close();
    }
  }
});

test("a resume() during another resume()'s flush leaves the record to it, and it clears the record once its flush is done", async () => {
  for (const where of ['recovery file', 'store only'] as const) {
    const h = await hostModeFixture(where);
    try {
      await h.framework.quiesce({ reason: 'surgery' });
      (h.framework as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage('user', [{ type: 'text', text: 'deferred' }]);
      // Hold the first resume() in its flush of the deferred writes.
      const internals = h.framework as unknown as { flushDeferredWrites(reason: string): Promise<unknown> };
      const flush = internals.flushDeferredWrites.bind(h.framework);
      let entered!: () => void;
      const inFlush = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      internals.flushDeferredWrites = async (reason: string) => { entered(); await held; return flush(reason); };
      const first = h.framework.resume();
      try {
        // A first resume() that settles without reaching its flush doesn't leave the test waiting here.
        await Promise.race([inFlush, first.then(() => {}, () => {})]);
        const status = await h.framework.resume();
        assert.equal(status.quiesced, false, `${where}: the second resume() answers serving`);
        assert.equal(h.recorded(), true, `${where}: and leaves the record to the first, mid-flush`);
      } finally {
        // Released whatever the assertions found, so stop() isn't left waiting on the first resume().
        release();
        await first.catch(() => {});
      }
      await first;
      assert.notEqual(h.recorded(), true, `${where}: the first clears it once its flush is done`);
      const texts = h.framework.getAgent('agent')!.getContextManager().getAllMessages()
        .map((m) => (m.content[0] as { text?: string } | undefined)?.text);
      assert.ok(texts.includes('deferred'), `${where}: and its flush landed the deferred write`);
    } finally {
      await h.close();
    }
  }
});

test("store only, a host-mode change whose sync fails rejects; with a recovery file, the file is the record and a failed sync of the store is only logged", async () => {
  const logged = captureErrors();
  try {
    const slot = await hostModeFixture('store only');
    try {
      await withFailingHostModeSync(async () => {
        await assert.rejects(slot.framework.quiesce({ reason: 'surgery' }), { message: 'injected EIO syncing the store' });
      });
      assert.equal(slot.framework.getHostModeStatus().quiesced, false, 'store only: a quiesce whose sync failed leaves the host serving');
      // The write reached the store before its sync failed, so the record may say quiesced: a resume() clears it.
      await slot.framework.resume();
      assert.notEqual(slot.recorded(), true, 'store only: resume() clears a record the failed quiesce may have left');
      await slot.restart();
      assert.equal(slot.framework.getHostModeStatus().quiesced, false, 'store only: and a restart boots serving');
      await slot.framework.quiesce({ reason: 'surgery' });
      await withFailingHostModeSync(async () => {
        await assert.rejects(slot.framework.resume(), { message: 'injected EIO syncing the store' });
      });
      await slot.framework.resume();
      assert.notEqual(slot.recorded(), true, 'store only: a resume whose sync failed is cleared by the next');
    } finally {
      await slot.close();
    }
    const file = await hostModeFixture('recovery file');
    try {
      await withFailingHostModeSync(async () => {
        await file.framework.quiesce({ reason: 'surgery' });
      });
      assert.equal(file.framework.getHostModeStatus().quiesced, true, 'recovery file: the quiesce holds');
      assert.equal(file.recorded(), true, 'recovery file: the file says quiesced');
      assert.ok(logged.lines.some((l) => l.includes('store sync after host-mode change failed')), 'recovery file: the failed sync is logged');
      await file.restart();
      assert.equal(file.framework.getHostModeStatus().quiesced, true, 'recovery file: a restart boots quiesced');
    } finally {
      await file.close();
    }
  } finally {
    logged.restore();
  }
});

test('resume gates on a fresh feasibility verdict; force overrides', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    await framework.quiesce();
    stubPreview(framework, 'agent', (budget) => ({
      finalTokens: 450_000,
      budgetTokens: budget.maxTokens,
      fits: false,
      exhausted: true,
      headTokens: 1,
      tailTokens: 2,
      middleTokens: 3,
      middleChunkCount: 1,
      deepestLevel: 3,
      resolutions: {},
      moves: 0,
      producedCount: 0,
    }));
    await assert.rejects(
      framework.resume(),
      (error: unknown) => {
        assert.ok(error instanceof ResumeBlockedError);
        assert.equal(error.verdicts.length, 1);
        assert.equal(error.verdicts[0].agentName, 'agent');
        assert.match(error.message, /folded floor 450000/);
        return true;
      },
    );
    assert.equal(framework.getHostModeStatus().quiesced, true, 'still quiesced after refusal');

    const forced = await framework.resume({ force: true });
    assert.equal(forced.quiesced, false);
  }, {
    strategy: autobiographical(),
    contextBudgetTokens: 300_000,
    maxTokens: 10_000,
  });
});

test('resume proceeds when the strategy cannot preview', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    // Default PassthroughStrategy: no previewContext at all.
    await framework.quiesce();
    const status = await framework.resume();
    assert.equal(status.quiesced, false);
  });
});

test('resume proceeds without a verdict for an agent whose context manager refuses, and warns naming it', async (t) => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    await framework.quiesce();
    // A failed strategy initialization fences the context manager: its
    // settings queries throw until a successful switchBranch or setStrategy.
    const cm = framework.getAgent('agent')!.getContextManager();
    const failing = {
      name: 'refusing-init-test',
      async initialize() { throw new Error('strategy initialization failed for the test'); },
      checkReadiness: () => ({ ready: true }),
      async tick() {},
      select: () => [],
    } as unknown as ContextStrategy;
    await assert.rejects(cm.setStrategy(failing), /strategy initialization failed for the test/);
    assert.throws(() => cm.getHotContextSettings(), /requires successful strategy initialization/);

    // The preview answers rather than throws: no verdict, with what the
    // agent's own state still says.
    // The agent runs at the default budget of 100,000 tokens, so 50,000 is a paced descent.
    const preview = framework.previewAgentRuntimeSettings('agent', { contextBudgetTokens: 50_000 });
    assert.equal(preview.available, false);
    assert.match(String(preview.reason), /requires successful strategy initialization/);
    assert.equal(preview.path, 'paced');
    assert.equal(preview.liveBudgetTokens, 100_000);
    assert.equal(preview.transition, 'stable');
    assert.equal(preview.effective, undefined);
    // A patch whose values the agent refuses still throws.
    assert.throws(() => framework.previewAgentRuntimeSettings('agent', { contextBudgetTokens: 5 }), /contextBudgetTokens must be/);
    assert.throws(() => framework.previewAgentRuntimeSettings('agent', { tailTokens: -1 }), /tailTokens must be/);
    // Whether the strategy takes a live tail or pace is the manager's to say,
    // so while it refuses, a patch that sets one gets no verdict either.
    for (const patch of [{ tailTokens: 2_000 }, { transitionPaceTokens: 1_000 }]) {
      const unanswered = framework.previewAgentRuntimeSettings('agent', patch);
      assert.equal(unanswered.available, false, JSON.stringify(patch));
      assert.match(String(unanswered.reason), /requires successful strategy initialization/);
      assert.equal(unanswered.liveBudgetTokens, 100_000);
    }

    // An update of the budget is refused, by the manager, and the preflight
    // doesn't say it's applying one.
    const preflight = t.mock.method(console, 'warn', () => {});
    try {
      assert.throws(
        () => framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 50_000 }),
        /requires successful strategy initialization/,
      );
      assert.ok(!preflight.mock.calls.some((call) => String(call.arguments[0]).includes('applying without preflight')));
    } finally {
      preflight.mock.restore();
    }
    assert.equal(framework.getAgent('agent')!.runtimeBudgetPath().liveBudgetTokens, 100_000, 'the budget is as it was');

    const warn = t.mock.method(console, 'warn', () => {});
    let status: Awaited<ReturnType<typeof framework.resume>>;
    try {
      status = await framework.resume();
    } finally {
      warn.mock.restore();
    }
    assert.equal(status.quiesced, false);
    assert.ok(warn.mock.calls.some((call) => {
      const line = String(call.arguments[0]);
      return line.includes('feasibility preview unavailable for agent')
        && line.includes('requires successful strategy initialization')
        && line.includes('proceeding without a verdict');
    }), 'resume warns, naming the agent and the reason');
  });
});

test('a preview stopped by a stale branch generation says branch_generation_changed, as the reason documents', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    await framework.quiesce();
    // As the autobiographical strategy refuses a branch it hasn't reloaded:
    // its readiness and its settings both say so.
    const stale = 'TestStrategy.getHotContextSettings requires reinitialization for the current branch generation';
    const strategy = {
      name: 'stale-generation-test',
      async initialize() {},
      checkReadiness: () => { throw new Error(stale); },
      getHotContextSettings: () => { throw new Error(stale); },
      updateHotContextSettings: () => { throw new Error(stale); },
      async tick() {},
      select: () => [],
    } as unknown as ContextStrategy;
    const cm = framework.getAgent('agent')!.getContextManager();
    await cm.setStrategy(strategy);
    const preview = framework.previewAgentRuntimeSettings('agent', { contextBudgetTokens: 50_000 });
    assert.equal(preview.available, false);
    assert.equal(preview.reason, 'branch_generation_changed');
    assert.equal(preview.liveBudgetTokens, 100_000);
  });
});

test('maintenanceTick runs the real maintenance pass while quiesced', async () => {
  class QueuedStrategy implements ContextStrategy {
    readonly name = 'queued-test';
    ticks = 0;
    checkReadiness(): ReadinessState {
      return { ready: this.ticks >= 2, description: 'test maintenance queued' };
    }
    async tick(_ctx: StrategyContext): Promise<void> {
      this.ticks++;
    }
    select(
      _store: MessageStoreView,
      _log: ContextLogView,
      _budget: TokenBudget,
    ): ContextEntry[] {
      return [];
    }
  }
  const strategy = new QueuedStrategy();
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    framework.start();
    await framework.quiesce({ reason: 'compression window' });
    const snapshot = await framework.maintenanceTick();
    assert.ok(strategy.ticks >= 2, `maintenance ticked while quiesced (${strategy.ticks})`);
    assert.ok(snapshot.agents.some((a) => a.agentName === 'agent'));
  }, { strategy });
});

test('maintenanceTick runs no pass while a surgery holds the store, and says so', async (t) => {
  class QueuedStrategy implements ContextStrategy {
    readonly name = 'queued-test';
    ticks = 0;
    checkReadiness(): ReadinessState {
      return { ready: false, description: 'test maintenance queued' };
    }
    async tick(_ctx: StrategyContext): Promise<void> {
      this.ticks++;
    }
    select(
      _store: MessageStoreView,
      _log: ContextLogView,
      _budget: TokenBudget,
    ): ContextEntry[] {
      return [];
    }
  }
  const strategy = new QueuedStrategy();
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    // Held before start(), whose first pass would otherwise tick at once.
    const internals = framework as unknown as { surgeryHold: { verb: string; agentName: string; since: number } | null };
    internals.surgeryHold = { verb: 'rollback', agentName: 'agent', since: Date.now() };
    framework.start();
    await framework.quiesce({ reason: 'compression window' });
    const warn = t.mock.method(console, 'warn', () => {});
    try {
      const snapshot = await framework.maintenanceTick();
      assert.equal(snapshot.ran, false);
      assert.equal(strategy.ticks, 0);
      assert.equal(snapshot.history.length, 0);
      assert.ok(warn.mock.calls.some((call) =>
        String(call.arguments[0]).includes('a rollback for agent holds the store — no pass executed')));
    } finally {
      internals.surgeryHold = null;
      warn.mock.restore();
    }
  }, { strategy });
});

// ---------------------------------------------------------------------------
// End-to-end MCPL leg: data plane held while quiesced, resume deliverable
// over host/command (control plane), and the resume reopens the data plane
// and flushes the backlog.
// ---------------------------------------------------------------------------

const QUIESCE_STDIO_SERVER = `
const fs = require('node:fs');
const statusPath = process.env.STATUS_PATH;
const pushPath = process.env.PUSH_PATH;
const resumePath = process.env.RESUME_PATH;
const log = (event, extra) =>
  fs.appendFileSync(statusPath, JSON.stringify({ event, ...extra }) + '\\n');
let buf = '';
let pushSent = false;
let resumeSent = false;
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5', pushEvents: true, featureSets: { chat: { description: 'chat', uses: ['pushEvents'] } } } } } });
    else if (m.method === 'tools/list') reply({ tools: [] });
    else if (m.method === 'featureSets/update') reply({ accepted: true });
    else if (m.id === 900) log('push-response', { result: m.result ?? null, error: m.error ?? null });
    else if (m.id === 901) log('resume-response', { result: m.result ?? null, error: m.error ?? null });
  }
});
setInterval(() => {
  if (!pushSent && fs.existsSync(pushPath)) {
    pushSent = true;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'push/event', params: {
      featureSet: 'chat', eventId: 'quiesce-push', timestamp: new Date().toISOString(),
      payload: { content: [{ type: 'text', text: 'held while quiesced' }] },
    } }) + '\\n');
    log('push-sent');
  }
  if (!resumeSent && fs.existsSync(resumePath)) {
    resumeSent = true;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 901, method: 'host/command', params: {
      command: 'resume', requesterName: 'test-operator',
    } }) + '\\n');
    log('resume-sent');
  }
}, 25);
`;

test('MCPL: pushes buffer while quiesced; host/command resume reopens and flushes', async () => {
  const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-mcpl-'));
  const statusPath = join(dir, 'status.jsonl');
  const pushPath = join(dir, 'push');
  const resumePath = join(dir, 'resume');
  const records = (): Array<{ event: string; [key: string]: unknown }> => jsonLines(statusPath);

  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
    mcplServers: [{
      id: 'pusher',
      command: process.execPath,
      args: ['-e', QUIESCE_STDIO_SERVER],
      allowHostCommands: true,
      env: { STATUS_PATH: statusPath, PUSH_PATH: pushPath, RESUME_PATH: resumePath },
    }],
  });
  try {
    framework.start();
    await framework.quiesce({ reason: 'mcpl leg' });

    writeFileSync(pushPath, 'go');
    await waitFor('push sent by server', () => records().some((r) => r.event === 'push-sent'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(
      !records().some((r) => r.event === 'push-response'),
      'push must buffer on the paused data plane — no response while quiesced',
    );
    assert.equal(membrane.calls.length, 0, 'no wake while quiesced');

    // Resume arrives OVER MCPL: host/command rides the control plane, so it
    // is deliverable through the very pause it lifts.
    writeFileSync(resumePath, 'go');
    await waitFor('resume handled via host/command', () =>
      records().some((r) => r.event === 'resume-response'
        && (r.result as { ok?: boolean } | null)?.ok === true));
    assert.equal(framework.getHostModeStatus().quiesced, false);
    await waitFor('buffered push flushed after resume', () =>
      records().some((r) => r.event === 'push-response'));
    const flushed = records().find((r) => r.event === 'push-response');
    assert.equal(flushed?.error, null, 'the flushed push is answered, not refused with an error');
    assert.equal((flushed?.result as { accepted?: unknown } | null)?.accepted, true, 'the flushed push is accepted');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review-fix regressions (code review 08-21)
// ---------------------------------------------------------------------------

/** A membrane whose stream produces its response only once the test opens
 *  its gate, so a turn stays in flight for as long as a test needs: a
 *  collapsed drain window returns undrained, a sane one waits for the turn. */
class GatedMembrane extends MockMembrane {
  private opened = false;
  private waiters: Array<() => void> = [];
  open(): void {
    this.opened = true;
    for (const wake of this.waiters.splice(0)) wake();
  }
  private gate(): Promise<void> {
    return this.opened ? Promise.resolve() : new Promise((resolve) => { this.waiters.push(resolve); });
  }
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    const inner = super.streamYielding(request, options);
    // A cancel lets this stream past the gate, to the aborted event its
    // inner stream then yields, so a test that fails before open() doesn't
    // leave stop() waiting on it.
    let cancelled!: () => void;
    const cancelling = new Promise<void>((resolve) => { cancelled = resolve; });
    const gate = () => Promise.race([this.gate(), cancelling]);
    return {
      cancel: () => { inner.cancel(); cancelled(); },
      provideToolResults: (...args: unknown[]) => (inner.provideToolResults as (...a: unknown[]) => void)(...args),
      get isWaitingForTools() { return inner.isWaitingForTools; },
      get pendingToolCallIds() { return inner.pendingToolCallIds; },
      get toolDepth() { return inner.toolDepth; },
      async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        await gate();
        yield* inner as unknown as AsyncIterable<StreamEvent>;
      },
    } as unknown as YieldingStream;
  }
}

test('a non-finite timeoutMs falls back to the default drain window, never NaN-collapses', async () => {
  // NaN reached quiesce() via Number('12O000') on the HTTP ingress. With the
  // old Math.max(1_000, NaN) the deadline was NaN and the drain window
  // collapsed to zero. Discriminating observable: a turn held in flight
  // until quiesce has begun is drained by a sane window, and a collapsed one
  // has already returned undrained by then.
  const membrane = new GatedMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'late' }]));
  await withFramework(membrane, async (framework) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('turn to start', () => membrane.calls.length === 1);
    const quiescing = framework.quiesce({ timeoutMs: Number('12O000') });
    // quiesce() marks the host quiesced, then checks the drain before its
    // first await, so the turn is still held at that check.
    await waitFor('quiesce to begin', () => framework.getHostModeStatus().quiesced);
    membrane.open();
    const status = await quiescing;
    assert.equal(status.quiesced, true);
    assert.equal(status.drained, true, 'the window waited for the turn');
  });
});

test('timeoutMs is clamped inside quiesce() — a sub-second value still drains a short turn', async () => {
  const membrane = new GatedMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'late' }]));
  await withFramework(membrane, async (framework) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('turn to start', () => membrane.calls.length === 1);
    // 1ms honoured literally would return undrained; the [1s, 10m] floor
    // (now inside quiesce(), shared by WS/HTTP/host-command) waits it out.
    // The subject is time, so the turn settles on a timer: its gate opens
    // 300 ms into the window. The drain looks again every 250 ms, and a
    // timer due sooner always fires first, so a 1 ms window ends at its
    // first look with the turn still held. A floor of 1 s looks again at
    // 500, 750 and 1000 ms, so a correct run fails only if none of those
    // looks finds the turn settled, which takes this process being held up
    // for most of that second.
    const quiescing = framework.quiesce({ timeoutMs: 1 });
    setTimeout(() => membrane.open(), 300);
    const status = await quiescing;
    assert.equal(status.drained, true);
  });
});

test('a concurrent resume() supersedes a draining quiesce: no abandon, no stale trace', async () => {
  const membrane = new HangingMembrane();
  await withFramework(membrane, async (framework) => {
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('turn to start', () => membrane.calls.length === 1);

    // A window sized for a hang, so the resume reaches it while it drains,
    // however slow the machine is. A resume that didn't supersede it would
    // show only when the window ends, 60 s on, abandoning the turn.
    const pending = framework.quiesce({ timeoutMs: 60_000, abandon: true });
    await waitFor('quiesce to begin', () => framework.getHostModeStatus().quiesced);
    await framework.resume();
    const status = await pending;
    assert.equal(status.quiesced, false, 'the superseded quiesce reports the live mode');
    assert.ok(
      !traces.some((t) => t.type === 'inference:aborted'),
      'the turn the quiesce was draining was NOT abandoned after the resume',
    );
    assert.ok(!traces.some((t) => t.type === 'host:quiesce'), 'no stale host:quiesce trace');
    // Release the hung turn so teardown is clean.
    framework.getAgent('agent')!.cancelStream();
    await waitFor('agent idle', () => framework.getAgent('agent')!.state.status === 'idle');
  });
});

test('the status lists the agents holding a turn, sorted, the set activeTurns counts', async () => {
  const membrane = new HangingMembrane();
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [
      { name: 'zed', model: 'test-model', systemPrompt: 'test' },
      { name: 'amy', model: 'test-model', systemPrompt: 'test' },
    ],
    modules: [],
  });
  try {
    assert.deepEqual(framework.getHostModeStatus().activeTurnAgents, [], 'no turn is held while idle');
    framework.start();
    framework.nudgeAgent('zed', 'operator');
    framework.nudgeAgent('amy', 'operator');
    await waitFor('both turns to start', () => membrane.calls.length === 2);
    const serving = framework.getHostModeStatus();
    assert.deepEqual(serving.activeTurnAgents, ['amy', 'zed'], 'both streams are running, listed in order');
    assert.equal(serving.activeTurns, 2, 'the list is the set activeTurns counts');

    const status = await framework.quiesce({ timeoutMs: 1_000, abandon: true });
    assert.equal(status.drained, true);
    assert.deepEqual(status.activeTurnAgents, [], 'the abandon ended both');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('abandon reports turns it cannot cancel (token held, no stream)', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    // A turn between dequeue and stream registration: token held, agent idle.
    const tokens = (framework as unknown as { activeTurnTokens: Map<string, object> }).activeTurnTokens;
    tokens.set('agent', {});
    setAbandonGraceForTests(framework, 50);
    try {
      const status = await framework.quiesce({ timeoutMs: 1_000, abandon: true });
      assert.equal(status.drained, false);
      assert.deepEqual(status.unabandonable, ['agent']);
      assert.deepEqual(status.activeTurnAgents, ['agent'], 'the turn it cannot cancel still holds its turn');
      const trace = traces.find((t) => t.type === 'host:quiesce') as { unabandonable?: string[] } | undefined;
      assert.deepEqual(trace?.unabandonable, ['agent']);
      assert.equal(membrane.calls.length, 0, 'nothing was cancelled or started');
    } finally {
      tokens.delete('agent');
    }
  });
});

test('a cancel that surfaces as a stream ERROR still settles as an operator abort', async () => {
  // Some stream implementations report cancellation through the error
  // branch rather than `aborted`; the quiesce_abandoned contract must hold
  // on both: no exhausted accounting, lifecycle 'aborted', agent back idle.
  class ErroringHangStream extends HangingStream {
    override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      await this.waitForCancel();
      yield { type: 'error', error: new Error('stream cancelled') } as StreamEvent;
    }
  }
  class ErroringMembrane extends MockMembrane {
    override streamYielding(request: NormalizedRequest): YieldingStream {
      this.calls.push(request);
      return new ErroringHangStream();
    }
  }
  const membrane = new ErroringMembrane();
  await withFramework(membrane, async (framework) => {
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    // The turn's lifecycle goes to MCPL servers granted it, through the hook
    // orchestrator, not to onTrace: stand one in that records it.
    const lifecycle: string[] = [];
    (framework as unknown as { hookOrchestrator: unknown }).hookOrchestrator = {
      beforeInference: async () => [],
      emitLifecycle: (params: { phase: string }) => { lifecycle.push(params.phase); },
    };
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('turn to start', () => membrane.calls.length === 1);
    const status = await framework.quiesce({ timeoutMs: 1_000, abandon: true });
    assert.equal(status.drained, true);
    await waitFor('agent back to idle', () => framework.getAgent('agent')!.state.status === 'idle');
    assert.ok(traces.some((t) => t.type === 'inference:aborted'
      && (t as { reason?: string }).reason === 'quiesce_abandoned'));
    assert.ok(!traces.some((t) => t.type === 'inference:exhausted'));
    // The cancel provenance is read BEFORE the failure accounting: the same
    // stream must not be reported failed and then aborted.
    assert.ok(!traces.some((t) => t.type === 'inference:failed'),
      'an abandoned turn is not first recorded as a provider failure');
    assert.deepEqual(lifecycle, ['started', 'aborted'], 'an abandoned turn ends its lifecycle "aborted", not "completed"');
  });
});

/** The `error` of each inference-log row the framework writes, in order. */
const loggedErrors = (framework: AgentFramework): string[] =>
  framework.queryInferenceLogs({ agentName: 'agent' }).entries.map((e) => e.entry.error ?? '(no error)');

test('an abandoned turn writes one inference-log row, attributed to the abandon', async () => {
  // Every other terminal of a stream writes an inference-log row, the
  // abandon's `error` twin included, so the log can attribute it later.
  const membrane = new HangingMembrane();
  await withFramework(membrane, async (framework) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('turn to start', () => membrane.calls.length === 1);
    const status = await framework.quiesce({ timeoutMs: 1_000, abandon: true });
    assert.equal(status.drained, true);
    await waitFor('agent back to idle', () => framework.getAgent('agent')!.state.status === 'idle');
    assert.deepEqual(loggedErrors(framework), ['Stream aborted: quiesce_abandoned']);
  });
});

test("an abandon stops the agent's running code_execution script with the turn", async () => {
  const membrane = new HangingMembrane();
  await withFramework(membrane, async (framework) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('turn to start', () => membrane.calls.length === 1);
    const ended: Array<[string, unknown, boolean, string | undefined]> = [];
    (framework as unknown as { codeExecution: unknown }).codeExecution = {
      scripts: {
        turnEnded: (agent: string, turn: unknown, abandoned: boolean, reason?: string) => { ended.push([agent, turn, abandoned, reason]); },
        dispose: async () => {},
        leftRunning: () => 0,
      },
    };
    const status = await framework.quiesce({ timeoutMs: 1_000, abandon: true });
    assert.equal(status.drained, true);
    await waitFor('agent back to idle', () => framework.getAgent('agent')!.state.status === 'idle');
    // The agent's scripts take it as an abandoned turn's end.
    const [first, second] = ended;
    assert.deepEqual([first?.[0], first?.[2], first?.[3]], ['agent', true, 'turn abandoned by quiesce']);
    assert.deepEqual([second?.[0], second?.[2], second?.[3]], ['agent', true, 'Turn abandoned by operator quiesce']);
  });
});

test('an abandon whose stream just closes still settles the turn as an operator abort', async () => {
  // A stream implementation may answer cancel() by just closing its
  // iterator, with no `aborted` or `error` event. The abandon still ends the
  // turn as its twins do: the agent back to idle, one inference:aborted with
  // the abandon's reason, one log row, and no failure accounting.
  class ClosingHangStream extends HangingStream {
    override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      await this.waitForCancel();
    }
  }
  class ClosingMembrane extends MockMembrane {
    override streamYielding(request: NormalizedRequest): YieldingStream {
      this.calls.push(request);
      return new ClosingHangStream();
    }
  }
  const membrane = new ClosingMembrane();
  await withFramework(membrane, async (framework) => {
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('turn to start', () => membrane.calls.length === 1);
    const status = await framework.quiesce({ timeoutMs: 1_000, abandon: true });
    assert.equal(status.drained, true);
    await waitFor('agent back to idle', () => framework.getAgent('agent')!.state.status === 'idle');
    const aborted = traces.filter((t) => t.type === 'inference:aborted').map((t) => (t as { reason?: string }).reason);
    assert.deepEqual(aborted, ['quiesce_abandoned']);
    assert.ok(!traces.some((t) => t.type === 'inference:exhausted' || t.type === 'inference:failed'),
      'an operator cancel must not feed the failure accounting');
    assert.deepEqual(loggedErrors(framework), ['Stream aborted: quiesce_abandoned']);
  });
});

test('abandon can escalate an already-quiesced, undrained host', async () => {
  class HangingStream implements YieldingStream {
    private pendingResolve: (() => void) | null = null;
    private aborted = false;
    cancel(): void { this.aborted = true; this.pendingResolve?.(); }
    provideToolResults(): void {}
    get isWaitingForTools() { return false; }
    get pendingToolCallIds(): string[] { return []; }
    get toolDepth() { return 0; }
    async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      if (!this.aborted) {
        await new Promise<void>((resolve) => { this.pendingResolve = resolve; });
      }
      yield { type: 'aborted', reason: 'user' } as StreamEvent;
    }
  }
  class HangingMembrane extends MockMembrane {
    override streamYielding(request: NormalizedRequest): YieldingStream {
      this.calls.push(request);
      return new HangingStream();
    }
  }
  const membrane = new HangingMembrane();
  await withFramework(membrane, async (framework) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('turn to start', () => membrane.calls.length === 1);

    const first = await framework.quiesce({ timeoutMs: 1_000 });
    assert.equal(first.drained, false, 'hung turn survives the first window');

    // Old behavior: `if (this.quiesced) return status` made this a no-op and
    // the only way out was resume()+re-quiesce, reopening planes mid-surgery.
    assert.deepEqual(first.activeTurnAgents, ['agent'], 'the first window lists the turn still held');
    const second = await framework.quiesce({ abandon: true });
    assert.equal(second.drained, true, 'second quiesce escalates to abandon');
    assert.deepEqual(second.activeTurnAgents, [], 'and the turn it ended holds none');
  });
});

test('context writes are deferred while quiesced and flushed by resume', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    await framework.quiesce({ reason: 'refold' });
    const cm = framework.getAgent('agent')!.getContextManager();
    const before = cm.getAllMessages().length;

    // Module events / api message.send route through framework.addMessage
    // (private — invoked here the way handleProcessEvent invokes it).
    (framework as unknown as {
      addMessage(participant: string, content: unknown[]): unknown;
    }).addMessage('user', [{ type: 'text', text: 'mid-surgery message' }]);
    assert.equal(
      cm.getAllMessages().length, before,
      'no context append while the window is open',
    );

    await framework.resume();
    assert.equal(
      cm.getAllMessages().length, before + 1,
      'the deferred write lands at resume',
    );
  });
});

test('a batch carrying a budget restart re-parks its sibling wakes instead of consuming them', async () => {
  const membrane = new MockMembrane();
  // The restart's continuation round needs a response to complete on — an
  // empty mock stream yields no `complete` and the agent never leaves
  // `streaming`, which reads as a scheduler hang rather than a re-park bug.
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'restart round' }]));
  await withFramework(membrane, async (framework) => {
    await framework.quiesce();
    // A parked wake exists...
    framework.nudgeAgent('agent', 'operator');
    // ...and a budget restart lands in the same pendingRequests batch.
    (framework as unknown as {
      pendingRequests: Array<Record<string, unknown>>;
    }).pendingRequests.push({
      agentName: 'agent',
      reason: 'context_budget_restart',
      source: 'framework',
      timestamp: Date.now(),
    });
    // Drive one scheduler pass: the restart starts its continuation turn, but
    // the nudge must survive as a parked request rather than being consumed
    // by it — exactly one provider call, and the survivor IS the nudge.
    await framework.runUntilIdle();
    await waitFor(
      'sibling wake re-parked',
      () => framework.getHostModeStatus().gatedRequests >= 1,
    );
    assert.equal(membrane.calls.length, 1, 'only the restart ran');
    const parked = (framework as unknown as { pendingRequests: Array<{ reason: string }> }).pendingRequests;
    assert.ok(parked.some((r) => r.reason.startsWith('admin-nudge')), 'the parked survivor is the nudge');
    assert.ok(!parked.some((r) => r.reason === 'context_budget_restart'), 'the restart was consumed');
  });
});

test('resume flushes deferred writes in order: a poison write stays queued with what follows it, and the reopen still completes', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    await framework.quiesce({ reason: 'refold' });
    const agent = framework.getAgent('agent')!;
    const cm = agent.getContextManager();
    const before = cm.getAllMessages().length;
    const add = (framework as unknown as {
      addMessage(participant: string, content: unknown[]): unknown;
    }).addMessage.bind(framework);
    add('user', [{ type: 'text', text: 'first' }]);
    add('user', [{ type: 'text', text: 'poison' }]);
    add('user', [{ type: 'text', text: 'third' }]);
    assert.equal(framework.getHostModeStatus().deferredWrites, 3);

    const realAdd = cm.addMessage.bind(cm);
    (cm as unknown as { addMessage: typeof cm.addMessage }).addMessage = ((participant, content, metadata, causedBy) => {
      const text = (content[0] as { text?: string }).text;
      if (text === 'poison') throw new Error('store write failed');
      return realAdd(participant, content, metadata, causedBy);
    }) as typeof cm.addMessage;

    const status = await framework.resume();
    assert.equal(status.quiesced, false);
    // A drained write whose store throws is never dropped, and nothing lands
    // ahead of it: it and the write queued behind it go back into the queue
    // under their ids, for the next flush.
    assert.equal(status.deferredWrites, 2, 'the write that failed and the one behind it are still queued');
    assert.deepEqual(
      cm.getAllMessages().slice(before).map((m) => (m.content[0] as { text: string }).text),
      ['first'],
      'the write queued before the poison one landed',
    );
    assert.ok(traces.some((t) => t.type === 'host:resume'), 'resume completed its follow-through');
  });
});

test('a write that fails at resume goes back into the queue once: the recovery file holds each entry once while the batch waits for its ack', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework, dir) => {
    await framework.quiesce({ reason: 'refold' });
    const cm = framework.getAgent('agent')!.getContextManager();
    const add = (framework as unknown as {
      addMessage(participant: string, content: unknown[]): unknown;
    }).addMessage.bind(framework);
    add('user', [{ type: 'text', text: 'first' }]);
    add('user', [{ type: 'text', text: 'poison' }]);
    add('user', [{ type: 'text', text: 'third' }]);

    const realAdd = cm.addMessage.bind(cm);
    (cm as unknown as { addMessage: typeof cm.addMessage }).addMessage = ((participant, content, metadata, causedBy) => {
      if ((content[0] as { text?: string }).text === 'poison') throw new Error('store write failed');
      return realAdd(participant, content, metadata, causedBy);
    }) as typeof cm.addMessage;
    // The batch's ack syncs the store before it rewrites the recovery file
    // without what landed. While that sync fails, the batch stays in the file
    // as it was handed off, beside what went back into the queue.
    const store = (framework as unknown as { store: { sync(): void } }).store;
    const realSync = store.sync.bind(store);
    let syncFails = true;
    store.sync = () => {
      if (syncFails) throw new Error('sync failed');
      realSync();
    };
    try {
      await framework.resume();
    } finally {
      syncFails = false;
    }

    const file = join(dir, 'store', 'recovery', 'deferred-writes.json');
    const pending = (JSON.parse(readFileSync(file, 'utf8')) as {
      pending: Array<{ id: string; content: Array<{ text: string }> }>;
    }).pending;
    assert.deepEqual(
      pending.map((entry) => entry.content[0]!.text),
      ['first', 'poison', 'third'],
      'the entry that landed waits for its ack, and the two that went back are in the queue, each once',
    );
    assert.equal(new Set(pending.map((entry) => entry.id)).size, 3, 'no id is written twice');
  });
});

test("resume stores several agents' writes in the order they arrived, and cuts each agent at its own stuck write, named at every flush", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-targets-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [
      { name: 'agent', model: 'test-model', systemPrompt: 'test' },
      { name: 'scout', model: 'test-model', systemPrompt: 'test' },
    ],
    modules: [],
  });
  const lines: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await framework.quiesce({ reason: 'refold' });
    const internals = framework as unknown as {
      deferredMessages: Array<{ id: string; content: Array<{ text?: string }> }>;
      addMessage(participant: string, content: unknown[], metadata?: undefined, opts?: { forAgent?: string }): unknown;
    };
    const add = (text: string, forAgent: string) =>
      internals.addMessage('user', [{ type: 'text', text }], undefined, { forAgent });
    // Residents share one message slot, so each one's context manager reads
    // what either stored; each stores through its own.
    const agentCm = framework.getAgent('agent')!.getContextManager();
    const before = agentCm.getAllMessages().length;
    const stored = () => agentCm.getAllMessages().slice(before).map((m) => (m.content[0] as { text: string }).text);
    add('one', 'agent');
    add('two', 'scout');
    add('three', 'agent');
    // A write whose content the store would accept, which the store below
    // refuses all the same; the log line names it by its blocks' types.
    internals.addMessage('user', [{ type: 'text', text: 'stuck' }, { type: 'text', text: 'and more' }], undefined, { forAgent: 'agent' });
    add('for scout', 'scout');
    add('behind the stuck one', 'agent');
    add('also for scout', 'scout');
    assert.equal(framework.getHostModeStatus().deferredWrites, 7);
    const stuckId = internals.deferredMessages.find((m) => m.content[0]?.text === 'stuck')!.id;

    // The store refuses agent's 'stuck' write with a thrown value that has no
    // text, so the log line can't print it.
    const realAdd = agentCm.addMessage.bind(agentCm);
    (agentCm as unknown as { addMessage: typeof agentCm.addMessage }).addMessage = ((participant, content, metadata, causedBy) => {
      if ((content[0] as { text?: string }).text === 'stuck') throw Object.create(null);
      return realAdd(participant, content, metadata, causedBy);
    }) as typeof agentCm.addMessage;
    const named = () => lines.filter((line) =>
      line.includes(`deferred write ${stuckId} (user: text) for agent could not be stored`)
      && line.includes('a thrown value that has no text')).length;

    let status = await framework.resume();
    // In the order they arrived, across both agents; from agent's stuck
    // write on, agent's are held, and scout's go on.
    assert.deepEqual(stored(), ['one', 'two', 'three', 'for scout', 'also for scout']);
    assert.equal(status.deferredWrites, 2, "agent's stuck write and the one behind it are still queued");
    assert.equal(named(), 1, 'the flush names the stuck write: its id and block types');

    // A second flush with the store still refusing it: held again, named again.
    await framework.quiesce({ reason: 'refold' });
    status = await framework.resume();
    assert.deepEqual(stored(), ['one', 'two', 'three', 'for scout', 'also for scout'], 'still nothing lands ahead of it');
    assert.equal(status.deferredWrites, 2);
    assert.equal(named(), 2, 'every flush names it');
  } finally {
    try {
      await framework.stop();
    } finally {
      console.error = error;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('boot recovery drops a malformed recovered deferred write, naming it, and restores the rest, after which the agent compiles', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-malformed-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  let framework = await AgentFramework.create(config());
  const lines: string[] = [];
  const error = console.error;
  try {
    await framework.quiesce({ reason: 'surgery' });
    const before = framework.getAgent('agent')!.getContextManager().getAllMessages().length;
    const add = (framework as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage.bind(framework);
    add('user', [{ type: 'text', text: 'first' }]);
    add('user', [{ type: 'text', text: 'second' }]);
    await framework.stop();

    // Entries no write of the framework's makes, as other code could leave
    // them in the recovery file: a null block, a string block and a number
    // block beside a text block, content that isn't blocks, a participant
    // that isn't text, which the line names by its type, and a target that
    // is empty or isn't text. A store before context-manager 0.16.0 kept a
    // string or number block, and every compile for the agent then threw,
    // since the context manager's token estimate keys a WeakMap on each
    // block; from 0.16.0 the store refuses one.
    const file = join(storePath, 'recovery', 'deferred-writes.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<Record<string, unknown>> };
    assert.equal(doc.pending.length, 2);
    const dropped = ['null-block', 'string-block', 'number-block', 'not-blocks', 'number-participant', 'empty-target', 'number-target'];
    doc.pending.splice(1, 0,
      { id: 'null-block', seq: 100, participant: 'user', content: [{ type: 'text', text: 'x' }, null] },
      { id: 'string-block', seq: 101, participant: 'user', content: [{ type: 'text', text: 'x' }, 'a bare string'] },
      { id: 'number-block', seq: 102, participant: 'user', content: [{ type: 'text', text: 'x' }, 42] },
      { id: 'not-blocks', seq: 103, participant: 'user', content: 'x' },
      { id: 'number-participant', seq: 104, participant: 42, content: [{ type: 'text', text: 'x' }] },
      { id: 'empty-target', seq: 105, participant: 'user', content: [{ type: 'text', text: 'x' }], forAgent: '' },
      { id: 'number-target', seq: 106, participant: 'user', content: [{ type: 'text', text: 'x' }], forAgent: 7 },
    );
    writeFileSync(file, JSON.stringify(doc));

    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    framework = await AgentFramework.create(config());
    console.error = error;
    assert.equal(framework.getHostModeStatus().deferredWrites, 2, 'the well-formed entries are restored');
    for (const entry of ['null-block (user)', 'string-block (user)', 'number-block (user)', 'not-blocks (user)', 'number-participant (participant of type number)', 'empty-target (user)', 'number-target (user)']) {
      assert.ok(lines.some((line) => line.includes(`malformed and was dropped: ${entry}`)), `${entry} is named:\n${lines.join('\n')}`);
    }
    const rewritten = readFileSync(file, 'utf8');
    assert.ok(!dropped.some((id) => rewritten.includes(id)), 'the recovery file is rewritten without them');
    await framework.resume();
    const texts = framework.getAgent('agent')!.getContextManager().getAllMessages().slice(before)
      .map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(texts, ['first', 'second']);
    await assert.doesNotReject(framework.getAgent('agent')!.compileContext(), 'and the agent compiles');
  } finally {
    console.error = error;
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a recovered deferred write context-manager refuses as malformed is dropped at the first flush, and the ack takes it out of the recovery file', { timeout: 60_000 }, async () => {
  // A write addMessage refuses now could sit in a queue an earlier process
  // persisted: a text block whose text isn't a string is an object block, so
  // boot restores it, and the store refuses it at the flush that meets it.
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-refused-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  let framework = await AgentFramework.create(config());
  const lines: string[] = [];
  const error = console.error;
  try {
    await framework.quiesce({ reason: 'surgery' });
    const before = framework.getAgent('agent')!.getContextManager().getAllMessages().length;
    const add = (framework as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage.bind(framework);
    add('user', [{ type: 'text', text: 'first' }]);
    add('user', [{ type: 'text', text: 'second' }]);
    await framework.stop();

    const file = join(storePath, 'recovery', 'deferred-writes.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<Record<string, unknown>> };
    assert.equal(doc.pending.length, 2);
    // Between the two writes, so the second is queued behind it: the second
    // moves up one seq, and the malformed entry takes its place.
    const second = doc.pending[1]!;
    const seq = second.seq as number;
    second.seq = seq + 1;
    doc.pending.splice(1, 0, { id: 'number-text', seq, participant: 'user', content: [{ type: 'text', text: 5 }] });
    writeFileSync(file, JSON.stringify(doc));

    framework = await AgentFramework.create(config());
    assert.equal(framework.getHostModeStatus().deferredWrites, 3, 'boot restores it with the others');
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    await framework.resume();
    console.error = error;
    assert.ok(lines.some((line) => line.includes("was refused as malformed, so it's dropped rather than queued again") && line.includes('content[0]')), lines.join('\n'));
    const texts = framework.getAgent('agent')!.getContextManager().getAllMessages().slice(before)
      .map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(texts, ['first', 'second'], 'what was queued behind it landed, in order');
    assert.equal(framework.getHostModeStatus().deferredWrites, 0, 'nothing is queued again');
    assert.ok(!readFileSync(file, 'utf8').includes('number-text'), 'and the recovery file no longer holds it');
  } finally {
    console.error = error;
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot recovery keeps one entry per id, and numbers a seq that isn\'t a positive whole number after the others', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-identity-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  let framework = await AgentFramework.create(config());
  const lines: string[] = [];
  const error = console.error;
  try {
    await framework.quiesce({ reason: 'surgery' });
    const before = framework.getAgent('agent')!.getContextManager().getAllMessages().length;
    const add = (framework as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage.bind(framework);
    add('user', [{ type: 'text', text: 'first' }]);
    add('user', [{ type: 'text', text: 'second' }]);
    await framework.stop();

    // What the framework never writes, as damage or a hand edit could leave
    // it: an id that comes twice, an entry with no id, a seq of 1e400 (JSON
    // reads it as Infinity), a negative one, zero and a string. The entries
    // with a bad seq come before 'second' in the file. Nothing here is
    // malformed, so only these make boot rewrite it.
    const file = join(storePath, 'recovery', 'deferred-writes.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<Record<string, unknown>> };
    assert.equal(doc.pending.length, 2);
    const entry = (id: string | undefined, seq: unknown, text: string) =>
      ({ ...(id === undefined ? {} : { id }), seq, participant: 'user', content: [{ type: 'text', text }] });
    doc.pending.splice(1, 0,
      entry('infinite-seq', '__INFINITY__', 'infinite seq'),
      entry('negative-seq', -3, 'negative seq'),
      entry('twice', 50, 'first with its id'),
      entry('twice', 51, 'second with its id'),
      entry('zero-seq', 0, 'zero seq'),
      entry('string-seq', 'seven', 'string seq'),
      entry(undefined, 52, 'no id'),
    );
    writeFileSync(file, JSON.stringify(doc).replace('"__INFINITY__"', '1e400'));

    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    framework = await AgentFramework.create(config());
    console.error = error;
    const named = (text: string) => assert.ok(lines.some((line) => line.includes(text)), `${text}:\n${lines.join('\n')}`);
    const late = 'not a positive whole number up to Number.MAX_SAFE_INTEGER; it is queued after the others';
    named('repeats id twice (user) and was dropped; the first entry with that id is kept');
    named(`(infinite-seq) has seq Infinity, ${late}`);
    named(`(negative-seq) has seq -3, ${late}`);
    named(`(zero-seq) has seq 0, ${late}`);
    named(`(string-seq) has seq of type string, ${late}`);
    named('a recovered deferred context write (user) has no id; it is given ');
    assert.equal(framework.getHostModeStatus().deferredWrites, 8);

    const rewritten = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<{ id: unknown; seq: unknown }> };
    assert.equal(rewritten.pending.length, 8, 'the recovery file is rewritten without the repeated id');
    assert.ok(rewritten.pending.every((m) => Number.isSafeInteger(m.seq) && (m.seq as number) > 0), JSON.stringify(rewritten.pending));

    await framework.resume();
    const texts = framework.getAgent('agent')!.getContextManager().getAllMessages().slice(before)
      .map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(texts, ['first', 'second', 'first with its id', 'no id', 'infinite seq', 'negative seq', 'zero seq', 'string seq']);
  } finally {
    console.error = error;
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot recovery restores a recovery file that predates seq in file order, and rewrites it with seqs', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-noseq-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  let framework = await AgentFramework.create(config());
  const lines: string[] = [];
  const error = console.error;
  try {
    await framework.quiesce({ reason: 'surgery' });
    const before = framework.getAgent('agent')!.getContextManager().getAllMessages().length;
    const add = (framework as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage.bind(framework);
    for (const text of ['first', 'second', 'third']) add('user', [{ type: 'text', text }]);
    await framework.stop();

    // A file written before entries carried a seq is in write order. Here
    // that order is third, first, second, so only the file can give it.
    const file = join(storePath, 'recovery', 'deferred-writes.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<Record<string, unknown>> };
    assert.equal(doc.pending.length, 3);
    const [first, second, third] = doc.pending.map(({ seq: _seq, ...rest }) => rest);
    writeFileSync(file, JSON.stringify({ version: 1, pending: [third, first, second] }));

    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    framework = await AgentFramework.create(config());
    console.error = error;
    assert.ok(!lines.some((line) => line.includes('has seq')), `an entry with no seq isn't named:\n${lines.join('\n')}`);
    const rewritten = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<{ seq: unknown; content: Array<{ text: string }> }> };
    assert.deepEqual(rewritten.pending.map((m) => [m.content[0]!.text, m.seq]), [['third', 1], ['first', 2], ['second', 3]],
      'rewritten with seqs, in file order');

    await framework.resume();
    const texts = framework.getAgent('agent')!.getContextManager().getAllMessages().slice(before)
      .map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(texts, ['third', 'first', 'second']);
  } finally {
    console.error = error;
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot recovery numbers the restored queue 1..N, so after a seq at Number.MAX_SAFE_INTEGER each deferral still gets a seq of its own', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-seq-limit-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  const add = (fw: AgentFramework, text: string) =>
    (fw as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage('user', [{ type: 'text', text }]);
  let framework = await AgentFramework.create(config());
  const lines: string[] = [];
  const error = console.error;
  try {
    await framework.quiesce({ reason: 'surgery' });
    const before = framework.getAgent('agent')!.getContextManager().getAllMessages().length;
    add(framework, 'first');
    await framework.stop();

    // A seq at the limit, as damage or a hand edit could leave it. It is a
    // valid seq, so boot names nothing and has no reason to rewrite the file.
    const file = join(storePath, 'recovery', 'deferred-writes.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<Record<string, unknown>> };
    assert.equal(doc.pending.length, 1);
    doc.pending[0]!.seq = Number.MAX_SAFE_INTEGER;
    const edited = JSON.stringify(doc);
    writeFileSync(file, edited);

    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    framework = await AgentFramework.create(config());
    assert.equal(readFileSync(file, 'utf8'), edited, "boot doesn't rewrite a file whose seqs are all valid");
    add(framework, 'second');
    add(framework, 'third');
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<{ seq: unknown; content: Array<{ text: string }> }> };
    assert.deepEqual(persisted.pending.map((m) => [m.content[0]!.text, m.seq]), [['first', 1], ['second', 2], ['third', 3]],
      'numbered 1..N at boot, and the deferrals after it go on from N');
    await framework.stop();

    framework = await AgentFramework.create(config());
    console.error = error;
    assert.ok(!lines.some((line) => line.includes('has seq')), `every seq the next boot reads is valid:\n${lines.join('\n')}`);
    await framework.resume();
    const texts = framework.getAgent('agent')!.getContextManager().getAllMessages().slice(before)
      .map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(texts, ['first', 'second', 'third']);
  } finally {
    console.error = error;
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context writes deferred while quiesced survive a restart and land at resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-deferred-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  let framework = await AgentFramework.create(config());
  try {
    await framework.quiesce({ reason: 'surgery' });
    const before = framework.getAgent('agent')!.getContextManager().getAllMessages().length;
    (framework as unknown as { addMessage(p: string, c: unknown[]): unknown })
      .addMessage('user', [{ type: 'text', text: 'said during surgery' }]);
    assert.equal(framework.getHostModeStatus().deferredWrites, 1);
    await framework.stop(); // crash-equivalent: the queue was in memory

    framework = await AgentFramework.create(config());
    assert.equal(framework.getHostModeStatus().quiesced, true);
    assert.equal(framework.getHostModeStatus().deferredWrites, 1, 'restored from the store');
    await framework.resume();
    const cm = framework.getAgent('agent')!.getContextManager();
    const texts = cm.getAllMessages().slice(before).map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(texts, ['said during surgery']);
    assert.equal(framework.getHostModeStatus().deferredWrites, 0);
    await framework.stop();

    framework = await AgentFramework.create(config());
    assert.equal(framework.getHostModeStatus().deferredWrites, 0, 'slot cleared after the flush');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review round 2 (antra-tess): admission bypass, branch-independent
// persistence, crash-safe resume flush.
// ---------------------------------------------------------------------------

test('a wake parked on provider admission does not start after quiesce; it runs at resume', async () => {
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'after resume' }]));
  await withFramework(membrane, async (framework) => {
    framework.start();
    const internals = framework as unknown as {
      withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>): Promise<T>;
      processInferenceRequests(): Promise<void>;
    };
    // Hold an auxiliary (compression-style) provider call in flight.
    let releaseAux!: () => void;
    const auxDone = internals.withAuxiliaryAdmission('agent', () =>
      new Promise<void>((resolve) => { releaseAux = resolve; }));
    await waitFor('auxiliary in flight', () => true);

    // A wake passes the scheduler and parks behind the auxiliary: it owns
    // provider admission but no turn token yet.
    framework.nudgeAgent('agent', 'operator');
    await internals.processInferenceRequests();
    assert.equal(framework.getHostModeStatus().parkedAdmissions, 1, 'admission owned, with no turn token yet');

    // Quiesce with a short window: the parked admission is NOT drained.
    const status = await framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
    assert.equal(status.quiesced, true);
    assert.equal(status.parkedAdmissions, 1, 'status reports the parked wake');
    assert.equal(status.drained, false, 'a parked admission is not "drained"');

    // Release the auxiliary: before the fix this started a turn while quiesced.
    const nextPass = schedulerPasses(framework, waitFor);
    releaseAux();
    await auxDone;
    await waitFor('admission released', () => framework.getHostModeStatus().parkedAdmissions === 0);
    // A pass over the requeued wake, which would have started it.
    await nextPass();
    assert.equal(membrane.calls.length, 0, 'NO inference while quiesced');
    assert.equal(framework.getHostModeStatus().quiesced, true);
    assert.ok(framework.getHostModeStatus().gatedRequests >= 1, 'the wake was requeued, not dropped');
    assert.equal(framework.getHostModeStatus().drained, true, 'drained once the admission was given back');

    await framework.resume();
    await waitFor('requeued wake to run after resume', () => membrane.calls.length === 1);
  });
});

test('quiesce survives a historical rollback + restart (host mode lives outside branch history)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-rollback-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  let framework = await AgentFramework.create(config());
  try {
    const cm = framework.getAgent('agent')!.getContextManager();
    const checkpoint = cm.addMessage('user', [{ type: 'text', text: 'checkpoint' }]);
    cm.addMessage('user', [{ type: 'text', text: 'later' }]);

    await framework.quiesce({ reason: 'refold' });
    (framework as unknown as { addMessage(p: string, c: unknown[]): unknown })
      .addMessage('user', [{ type: 'text', text: 'deferred during surgery' }]);
    assert.equal(framework.getHostModeStatus().deferredWrites, 1);

    // The surgery itself: time-travel to before the quiesce marker was written.
    const branch = cm.branchAt(checkpoint, 'rollback/agent/test');
    await cm.switchBranch(branch);
    assert.equal(framework.getHostModeStatus().quiesced, true, 'live flag unaffected');
    assert.equal(existsSync(join(storePath, 'recovery', 'host-mode.json')), true, 'marker is a recovery file');
    await framework.stop();

    framework = await AgentFramework.create(config());
    const booted = framework.getHostModeStatus();
    assert.equal(booted.quiesced, true, 'a restart after a rollback still boots quiesced');
    assert.equal(booted.reason, 'refold');
    assert.equal(booted.deferredWrites, 1, 'deferred writes were not orphaned by the rollback either');
    assert.equal(framework.getAgent('agent')!.getContextManager().currentBranch().name, 'rollback/agent/test');

    await framework.resume();
    assert.equal(framework.getHostModeStatus().quiesced, false);
    const texts = framework.getAgent('agent')!.getContextManager().getAllMessages()
      .map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(texts.slice(-2), ['checkpoint', 'deferred during surgery']);
    await framework.stop();

    framework = await AgentFramework.create(config());
    assert.equal(framework.getHostModeStatus().quiesced, false, 'resume cleared the recovery file durably');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed chronicle sync keeps flushed deferred writes in the durable queue until a sync succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-syncfail-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  let framework = await AgentFramework.create(config());
  try {
    await framework.quiesce({ reason: 'surgery' });
    const before = framework.getAgent('agent')!.getContextManager().getMessageCount();
    const add = (framework as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage.bind(framework);
    add('user', [{ type: 'text', text: 'one' }]);
    add('user', [{ type: 'text', text: 'two' }]);
    const queuePath = join(storePath, 'recovery', 'deferred-writes.json');
    const pending = () => (JSON.parse(readFileSync(queuePath, 'utf8')) as { pending: Array<{ participant: string }> }).pending.length;
    assert.equal(pending(), 2);

    // Every sync during resume fails: the messages are appended in memory
    // but must NOT be acknowledged — the durable queue keeps both.
    const store = (framework as unknown as { store: { sync(): void } }).store;
    const realSync = store.sync.bind(store);
    store.sync = () => { throw new Error('disk full'); };
    await framework.resume();
    assert.deepEqual(
      framework.getAgent('agent')!.getContextManager().getAllMessages().slice(before)
        .map((m) => (m.content[0] as { text: string }).text),
      ['one', 'two'],
      'landed in memory',
    );
    assert.equal(framework.getHostModeStatus().deferredWrites, 0, 'nothing left pending in memory');
    assert.equal(pending(), 2, 'durable queue still lists both — not acked without a sync');

    // Sync works again: stop() acks (sync, then rewrite the queue).
    store.sync = realSync;
    await framework.stop();
    assert.equal(pending(), 0, 'acked once the chronicle state was durable');

    framework = await AgentFramework.create(config());
    assert.equal(framework.getHostModeStatus().deferredWrites, 0);
    assert.deepEqual(
      framework.getAgent('agent')!.getContextManager().getAllMessages().slice(before)
        .map((m) => (m.content[0] as { text: string }).text),
      ['one', 'two'],
      'exactly once after reopen',
    );
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

const CRASH_CHILD = fileURLToPath(new URL('./helpers/quiesce-crash-child.js', import.meta.url));

function runCrashChild(
  storePath: string,
  mode: string,
  abort: AbortSignal,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CRASH_CHILD, storePath, mode], { signal: abort, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let failure: Error | undefined;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      failure = error;
      if (child.pid === undefined) reject(error);
    });
    child.on('close', (status, signal) => {
      if (failure) reject(new Error(`${failure.message} (stderr: ${stderr.slice(-800)})`, { cause: failure }));
      else resolve({ status, signal, stderr });
    });
  });
}

const CRASH_SCENARIOS = [
  { mode: 'after-ack', label: 'right after the first ack of the resume flush',
    expect: ['ACKED-BUT-NOT-SYNCED', 'STILL-PENDING'], bootQuiesced: true },
  { mode: 'before-sync', label: 'before the chronicle sync of the resume flush',
    expect: ['ACKED-BUT-NOT-SYNCED', 'STILL-PENDING'], bootQuiesced: true },
  { mode: 'turn-start-ack', label: "after an ORDINARY turn-start flush's sync but before its queue rewrite",
    expect: ['ONCE-ONLY'], bootQuiesced: false },
  { mode: 'redefer', label: "at the first re-deferral write of a two-message batch (abandoned turn's teardown while quiesced)",
    expect: ['REDEFER-FIRST', 'REDEFER-SECOND'], bootQuiesced: true },
  { mode: 'big-batch', label: 'after a 2,101-message resume batch was synced but before it was acked',
    expect: Array.from({ length: 2_101 }, (_, i) => `BIG-${i}`), bootQuiesced: true },
] as const;

for (const scenario of CRASH_SCENARIOS) {
  test(`a REAL process exit ${scenario.label} loses no deferred write and duplicates none`, async (context) => {
    const dir = mkdtempSync(join(tmpdir(), `host-quiesce-crash-${scenario.mode}-`));
    const storePath = join(dir, 'store');
    const config = () => ({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      modules: [],
    });
    let framework: AgentFramework | null = null;
    try {
      const child = await runCrashChild(storePath, scenario.mode, context.signal);
      assert.equal(child.status, 0, `child staged the crash (signal: ${child.signal}; stderr: ${child.stderr.slice(-800)})`);

      const wanted = new Set<string>(scenario.expect);
      const texts = () => framework!.getAgent('agent')!.getContextManager().getAllMessages()
        .map((m) => (m.content[0] as { text: string }).text)
        .filter((t) => wanted.has(t));

      framework = await AgentFramework.create(config());
      const booted = framework.getHostModeStatus();
      assert.equal(booted.quiesced, scenario.bootQuiesced);
      if (booted.quiesced) await framework.resume();
      assert.deepEqual(texts(), [...scenario.expect], 'present exactly once, in order');
      assert.equal(framework.getHostModeStatus().deferredWrites, 0);
      await framework.stop();

      framework = await AgentFramework.create(config());
      assert.equal(framework.getHostModeStatus().quiesced, false);
      assert.equal(framework.getHostModeStatus().deferredWrites, 0);
      assert.deepEqual(texts(), [...scenario.expect], 'still exactly once after a second reopen');
    } finally {
      await framework?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a serving boot recovers a stranded deferred-write queue regardless of the mode flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-stranded-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  let framework = await AgentFramework.create(config());
  let before: number;
  try {
    before = framework.getAgent('agent')!.getContextManager().getMessageCount();
    await framework.stop();
    // The state an older build could leave behind: flag cleared, queue not.
    mkdirSync(join(storePath, 'recovery'), { recursive: true });
    writeFileSync(join(storePath, 'recovery', 'host-mode.json'), JSON.stringify({ version: 1, quiesced: false }));
    writeFileSync(join(storePath, 'recovery', 'deferred-writes.json'), JSON.stringify({
      version: 1,
      pending: [{ id: 'stranded-1', participant: 'user', content: [{ type: 'text', text: 'stranded' }] }],
    }));

    framework = await AgentFramework.create(config());
    assert.equal(framework.getHostModeStatus().quiesced, false);
    assert.equal(framework.getHostModeStatus().deferredWrites, 0, 'recovered at boot');
    const texts = framework.getAgent('agent')!.getContextManager().getAllMessages().slice(before)
      .map((m) => (m.content[0] as { text: string }).text);
    assert.deepEqual(texts, ['stranded']);
    const queue = JSON.parse(readFileSync(join(storePath, 'recovery', 'deferred-writes.json'), 'utf8')) as { pending: unknown[] };
    assert.equal(queue.pending.length, 0, 'acked durably');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nudge while quiesced says so', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    await framework.quiesce();
    const r = framework.nudgeAgent('agent', 'operator');
    assert.equal(r.ok, true);
    assert.equal(r.quiesced, true);
    assert.equal(framework.getHostModeStatus().gatedRequests, 1);
  });
});

test("an abandon whose cancel throws for one agent goes on to abandon the next agent's turn", async () => {
  const membrane = new HangingMembrane();
  const dir = mkdtempSync(join(tmpdir(), 'host-quiesce-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [
      { name: 'first', model: 'test-model', systemPrompt: 'test' },
      { name: 'second', model: 'test-model', systemPrompt: 'test' },
    ],
    modules: [],
  });
  const errors = captureErrors();
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => traces.push(event));
  const abortedAs = (name: string) => traces
    .filter((t) => t.type === 'inference:aborted' && (t as { agentName?: string }).agentName === name)
    .map((t) => (t as { reason?: string }).reason);
  let restore: (() => void) | undefined;
  try {
    framework.start();
    // first takes its turn token before second, so the abandon reaches it first.
    framework.nudgeAgent('first', 'operator');
    await waitFor("first's turn to start", () => membrane.calls.length === 1);
    framework.nudgeAgent('second', 'operator');
    await waitFor("second's turn to start", () => membrane.calls.length === 2);
    const stream = (framework.getAgent('first')!.state as { stream?: { cancel(): void } }).stream!;
    const cancel = stream.cancel.bind(stream);
    stream.cancel = () => { throw new Error('zz the stream refused its cancel'); };
    restore = () => { stream.cancel = cancel; };
    const quiescing = framework.quiesce({ timeoutMs: 50, abandon: true });
    await waitFor("second's turn to end as abandoned", () => abortedAs('second').length > 0);
    assert.deepEqual(abortedAs('second'), ['quiesce_abandoned']);
    assert.ok(errors.lines.some((l) => l.startsWith("[host-mode] cannot abandon turn for first: its stream's cancel threw")),
      errors.lines.join('\n'));
    // first's stream goes on; a caller's stop ends it, and with it the abandon's grace.
    restore();
    assert.equal(framework.abortInference('first', 'user'), true);
    const status = await quiescing;
    assert.equal(status.quiesced, true);
    assert.deepEqual(abortedAs('first'), ['user'], "first's turn ends as the caller's stop, not as abandoned");
  } finally {
    restore?.();
    errors.restore();
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
