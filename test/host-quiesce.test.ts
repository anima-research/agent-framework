/**
 * Host quiesce/maintenance mode (issue #122) — deterministic state-machine
 * coverage. No child processes; the MCPL plane/barrier interplay is covered
 * by the awareness-barrier suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

import { AgentFramework, ResumeBlockedError } from '../src/index.js';
import type { TraceEvent } from '../src/types/trace.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

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

    const nudge = framework.nudgeAgent('agent', 'operator');
    assert.equal(nudge.ok, true);
    // Give the running loop time to (not) start a turn.
    await new Promise((resolve) => setTimeout(resolve, 300));
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
    for (let i = 0; i < 5; i++) framework.nudgeAgent('agent', 'operator');
    // The loop's next pass compresses same-reason parked requests to one.
    await waitFor(
      'coalescing to a single parked request',
      () => framework.getHostModeStatus().gatedRequests === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
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
    await new Promise((resolve) => setTimeout(resolve, 200));
    const survivors = pending().filter((r) => r.reason === 'mcpl:channel-incoming');
    assert.equal(survivors.length, 2, 'one addressed + one ambient survive');
    assert.ok(survivors.some((r) => r.addressed === true && r.channelId === 'dm'), 'the addressed wake survived');
    assert.ok(survivors.some((r) => r.addressed === false), 'the newest ambient wake survived');
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

test('resume proceeds with a warn when the strategy cannot preview', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    // Default PassthroughStrategy: no previewContext at all.
    await framework.quiesce();
    const status = await framework.resume();
    assert.equal(status.quiesced, false);
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

// ---------------------------------------------------------------------------
// End-to-end MCPL leg: data plane held while quiesced, resume deliverable
// over host/command (control plane), funnel reopens and flushes the backlog.
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
    if (m.method === 'initialize') reply({ capabilities: { experimental: { mcpl: { version: '0.4', pushEvents: true } } } });
    else if (m.method === 'tools/list') reply({ tools: [] });
    else if (m.id === 900) log('push-response', { error: m.error ?? null });
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
  const records = (): Array<{ event: string; [key: string]: unknown }> =>
    existsSync(statusPath)
      ? readFileSync(statusPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];

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
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review-fix regressions (code review 08-21)
// ---------------------------------------------------------------------------

/** A membrane whose stream sleeps before producing its response — a turn
 *  that settles on its own after `delayMs`, so a drain window's real length
 *  becomes observable: a collapsed window returns undrained immediately, a
 *  sane one waits for the turn. */
class DelayedMembrane extends MockMembrane {
  constructor(private readonly delayMs: number) { super(); }
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    const inner = super.streamYielding(request, options);
    const delayMs = this.delayMs;
    return {
      cancel: () => inner.cancel(),
      provideToolResults: (...args: unknown[]) => (inner.provideToolResults as (...a: unknown[]) => void)(...args),
      get isWaitingForTools() { return inner.isWaitingForTools; },
      get pendingToolCallIds() { return inner.pendingToolCallIds; },
      get toolDepth() { return inner.toolDepth; },
      async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield* inner as unknown as AsyncIterable<StreamEvent>;
      },
    } as unknown as YieldingStream;
  }
}

test('a non-finite timeoutMs falls back to the default drain window, never NaN-collapses', async () => {
  // NaN reached quiesce() via Number('12O000') on the HTTP ingress. With the
  // old Math.max(1_000, NaN) the deadline was NaN and the drain window
  // collapsed to zero. Discriminating observable: a turn that settles after
  // 600ms is drained by a sane window and NOT by a collapsed one.
  const membrane = new DelayedMembrane(600);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'late' }]));
  await withFramework(membrane, async (framework) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('turn to start', () => membrane.calls.length === 1);
    const started = Date.now();
    const status = await framework.quiesce({ timeoutMs: Number('12O000') });
    assert.equal(status.quiesced, true);
    assert.equal(status.drained, true, 'the window waited for the turn');
    assert.ok(Date.now() - started >= 400, 'quiesce actually waited');
  });
});

test('timeoutMs is clamped inside quiesce() — a sub-second value still drains a short turn', async () => {
  const membrane = new DelayedMembrane(600);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'late' }]));
  await withFramework(membrane, async (framework) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('turn to start', () => membrane.calls.length === 1);
    // 1ms honoured literally would return undrained; the [1s, 10m] floor
    // (now inside quiesce(), shared by WS/HTTP/host-command) waits it out.
    const status = await framework.quiesce({ timeoutMs: 1 });
    assert.equal(status.drained, true);
    assert.equal(AgentFramework.QUIESCE_TIMEOUT_MAX_MS, 600_000);
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

    const pending = framework.quiesce({ timeoutMs: 5_000, abandon: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(framework.getHostModeStatus().quiesced, true, 'draining');
    await framework.resume();
    const status = await pending;
    assert.equal(status.quiesced, false, 'the superseded quiesce reports the live mode');
    assert.ok(
      !traces.some((t) => t.type === 'inference:aborted'),
      'the turn that outlived the window was NOT abandoned after the resume',
    );
    assert.ok(!traces.some((t) => t.type === 'host:quiesce'), 'no stale host:quiesce trace');
    // Release the hung turn so teardown is clean.
    framework.getAgent('agent')!.cancelStream();
    await waitFor('agent idle', () => framework.getAgent('agent')!.state.status === 'idle');
  });
});

test('abandon reports turns it cannot cancel (token held, no stream)', async () => {
  const membrane = new MockMembrane();
  await withFramework(membrane, async (framework) => {
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    // A turn between dequeue and stream registration: token held, agent idle.
    const tokens = (framework as unknown as { activeTurnTokens: Map<string, object> }).activeTurnTokens;
    tokens.set('agent', {});
    try {
      const status = await framework.quiesce({ timeoutMs: 1_000, abandon: true });
      assert.equal(status.drained, false);
      assert.deepEqual(status.unabandonable, ['agent']);
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
    const lifecycle = traces
      .filter((t) => String(t.type).includes('lifecycle'))
      .map((t) => (t as { phase?: string }).phase);
    if (lifecycle.length > 0) assert.ok(!lifecycle.includes('completed'), 'an abandoned turn is not "completed"');
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
    const second = await framework.quiesce({ abandon: true });
    assert.equal(second.drained, true, 'second quiesce escalates to abandon');
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

test('resume flushes deferred writes per message: one poison write neither drops the rest nor skips the reopen', async () => {
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
    assert.equal(status.deferredWrites, 0, 'the queue is drained even though one write failed');
    assert.deepEqual(
      cm.getAllMessages().slice(before).map((m) => (m.content[0] as { text: string }).text),
      ['first', 'third'],
      'the writes behind the poison one still landed',
    );
    assert.ok(traces.some((t) => t.type === 'host:resume'), 'resume completed its follow-through');
  });
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
      providerGates: Map<string, { primaryDepth: number }>;
      activeTurnTokens: Map<string, number>;
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
    assert.equal(internals.providerGates.get('agent')?.primaryDepth, 1, 'admission owned');
    assert.equal(internals.activeTurnTokens.size, 0, 'no turn token yet');

    // Quiesce with a short window: the parked admission is NOT drained.
    const status = await framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
    assert.equal(status.quiesced, true);
    assert.equal(status.parkedAdmissions, 1, 'status reports the parked wake');
    assert.equal(status.drained, false, 'a parked admission is not "drained"');

    // Release the auxiliary: before the fix this started a turn while quiesced.
    releaseAux();
    await auxDone;
    await waitFor('admission released', () => (internals.providerGates.get('agent')?.primaryDepth ?? 0) === 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  test(`a REAL process exit ${scenario.label} loses no deferred write and duplicates none`, async () => {
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
      const child = spawnSync(process.execPath, [CRASH_CHILD, storePath, scenario.mode], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(child.status, 0, `child staged the crash (stderr: ${child.stderr.slice(-800)})`);

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
