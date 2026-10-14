/**
 * A compile refused for budget holds its turn (#304). An immediate budget
 * decrease, or a turn that grew the context past the budget, makes the next
 * compile refuse with context-manager's OverBudgetError before any provider
 * call. Before the hold, the error policy retried it into the same refusal
 * within seconds and the turn ended; compression then freed the space, but
 * nothing ran the turn again, so the resident stayed silent until its next
 * wake. Now the turn waits while compression runs, and runs once a dry-run
 * compile fits: later wakes join it, and a deadline, or compression with
 * nothing left to do, ends it as a refused compile ended before.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '@animalabs/context-manager';
import type { EventResponse, Module, ProcessEvent, TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import type { NormalizedRequest, YieldingStream } from '@animalabs/membrane';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

/** One queued response per stream, so each turn gets its own. */
class SequentialStreamMembrane extends MockMembrane {
  private streamIdx = 0;
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.responses.slice(this.streamIdx, ++this.streamIdx));
    this.lastStream = stream;
    return stream;
  }
}

async function pollUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function stored(framework: AgentFramework): Array<{ text: string; metadata: Record<string, unknown> }> {
  const cm = framework.getAgent('prime')?.getContextManager();
  const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{
    content: Array<{ type: string; text?: string }>;
    metadata?: Record<string, unknown>;
  }>;
  return msgs.map((m) => ({
    text: (m.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n'),
    metadata: m.metadata ?? {},
  }));
}
const storedText = (framework: AgentFramework): string => stored(framework).map((m) => m.text).join('\n');

/**
 * The context manager's compression backlog: every compile is refused until
 * `fitAt` ticks have run (or `fit` is set), and pending work is reported
 * until then, or until `readyAt` ticks, whichever is sooner, as a strategy
 * reports a backlog. The maintenance loop and the drain kick tick it. A
 * compile decides at its start, as the context manager selects at its start;
 * a dry run then waits for `dryRunGate` when one is set, and throws
 * `dryRunError` once when one is set.
 */
interface Backlog {
  ticks: number; fitAt: number; readyAt: number; fit: boolean;
  dryRuns: number; compiles: number;
  dryRunGate?: Promise<void>; dryRunError?: Error;
}
const fits = (b: Backlog): boolean => b.fit || b.ticks >= b.fitAt;
const pending = (b: Backlog): boolean => !fits(b) && b.ticks < b.readyAt;

type Patchable = Record<'compile' | 'tick' | 'isReady', (...args: unknown[]) => unknown>;

async function withBacklog<T>(backlog: Partial<Backlog>, run: (b: Backlog) => Promise<T>): Promise<T> {
  const b: Backlog = { ticks: 0, fitAt: Infinity, readyAt: Infinity, fit: false, dryRuns: 0, compiles: 0, ...backlog };
  const proto = ContextManager.prototype as unknown as Patchable;
  const original = { compile: proto.compile, tick: proto.tick, isReady: proto.isReady };
  proto.compile = async function (this: unknown, ...args: unknown[]) {
    const dryRun = (args[2] as { dryRun?: boolean } | undefined)?.dryRun === true;
    if (dryRun) b.dryRuns++;
    else b.compiles++;
    const fitsNow = fits(b);
    if (dryRun && b.dryRunGate) await b.dryRunGate;
    if (dryRun && b.dryRunError) {
      const error = b.dryRunError;
      b.dryRunError = undefined;
      throw error;
    }
    if (!fitsNow) {
      throw Object.assign(
        new Error('Compile plan would exceed hard budget: head=41200 tail=8100 middle=62000 budget=48568'),
        { name: 'OverBudgetError', budget: 48_568, actual: 100_201 },
      );
    }
    return original.compile.apply(this, args);
  };
  proto.tick = async function () { b.ticks++; };
  proto.isReady = function () { return !pending(b); };
  try {
    return await run(b);
  } finally {
    Object.assign(proto, original);
  }
}

/** Stores each external message for the agent and asks for a turn, as a
 *  channel module does. */
class InboxModule implements Module {
  readonly name = 'inbox';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools() { return []; }
  async handleToolCall(): Promise<never> { throw new Error('no tools'); }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
      requestInference: true,
    };
  }
}

/** The framework's internals these tests read or shorten. */
interface Internal {
  budgetHoldMs: number;
  budgetHoldRecheckMs: number;
  budgetHolds: Map<string, unknown>;
  budgetHoldCarry: Map<string, unknown>;
  budgetHoldSpent: Map<string, unknown>;
  budgetHoldNotes: Map<string, unknown>;
  activeTurnTokens: Map<string, number>;
  pendingRequests: Array<{ agentName: string }>;
  providerGateBlocked: (agentName: string) => boolean;
  disposeConversationAgent: (agentName: string) => void;
}

const heldRequests = (framework: AgentFramework): number | undefined => {
  const agents = (framework.healthSnapshot() as { agents: Array<{ name: string; budgetHold: { heldRequests: number } | null }> }).agents;
  return agents.find((a) => a.name === 'prime')?.budgetHold?.heldRequests;
};

async function residentTurn(options: { maintenanceIntervalMs: number; holdMs?: number; recheckMs?: number; responses?: number }) {
  const tempDir = mkdtempSync(join(tmpdir(), 'budget-hold-'));
  const membrane = new SequentialStreamMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Answered once it fit' }]));
  for (let i = 1; i < (options.responses ?? 1); i++) {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: `Answered turn ${i + 1}` }]));
  }
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.' }],
    modules: [new InboxModule()],
    syncIntervalMs: 0,
    maintenanceIntervalMs: options.maintenanceIntervalMs,
    // The default policy's three retries, without its 1, 2 and 4 second waits.
    errorPolicy: { maxRetries: 3, onInferenceError: (_error, _agent, attempt) => (attempt < 3 ? { retry: true, delayMs: 0 } : { retry: false }) },
  });
  const internal = framework as unknown as Internal;
  if (options.holdMs !== undefined) internal.budgetHoldMs = options.holdMs;
  if (options.recheckMs !== undefined) internal.budgetHoldRecheckMs = options.recheckMs;
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e));
  const send = (text: string) => framework.pushEvent({
    type: 'external-message',
    source: 'test',
    content: [{ type: 'text', text }],
    metadata: {},
    triggerInference: true,
  } as unknown as ProcessEvent);
  framework.start();
  const of = (type: string) => traces.filter((e) => e.type === type) as unknown as Array<Record<string, unknown>>;
  return {
    framework,
    internal,
    membrane,
    send,
    of,
    close: async () => {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe('a compile refused for budget holds its turn (#304)', () => {
  it('runs the refused turn once compression makes the context fit, with no new wake', async () => {
    await withBacklog({ fitAt: 12 }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => fits(backlog), 10_000), 'compression should catch up');
        const answered = await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000);
        assert.ok(answered, 'the refused turn should run once the context fits, with no new message to wake it');
        assert.equal(t.membrane.calls.length, 1, 'one provider call: the fresh compile after the hold, never a refused one');

        const held = t.of('inference:held');
        assert.equal(held.length, 1);
        assert.equal(held[0]!.errorType, 'over_budget');
        assert.equal(held[0]!.budget, 48_568);
        assert.equal(held[0]!.actual, 100_201);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
        assert.deepEqual(t.of('inference:exhausted'), [], 'the turn never failed');
      } finally {
        await t.close();
      }
    });
  });

  it('tells the agent why its turn waited, in that turn\'s compile alone', async () => {
    await withBacklog({ fitAt: 12 }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, responses: 2 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 10_000));
        const first = JSON.stringify(t.membrane.calls[0]);
        assert.match(first, /\[budget-hold\] Your context didn't fit its budget \(100,201 tokens against 48,568\), so this turn waited \d+ s while compression caught up\. It fits now\./);
        // An injection, never stored: no later turn sees it, and no stored
        // message could move a turn's routing (#333's arrival rule).
        assert.ok(!storedText(t.framework).includes('[budget-hold]'), 'the note is not stored');
        t.send('And now?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered turn 2'), 5_000));
        assert.equal(t.membrane.calls.length, 2);
        assert.ok(!JSON.stringify(t.membrane.calls[1]).includes('[budget-hold]'), 'the next turn carries no note');
      } finally {
        await t.close();
      }
    });
  });

  it('takes later wakes into the held turn, for one compile', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('First message');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        t.send('Second message, while held');
        assert.ok(await pollUntil(() => heldRequests(t.framework) === 2, 5_000), 'the second wake joins the hold');
        assert.equal(t.membrane.calls.length, 0, 'no compile while held, so no provider call');
        assert.equal(t.of('inference:failed').length, 1, 'only the first refusal: the second wake never compiled while held');
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        assert.equal(t.membrane.calls.length, 1, 'both wakes ran as one turn');
        const request = JSON.stringify(t.membrane.calls[0]);
        assert.ok(request.includes('First message') && request.includes('Second message, while held'));
        assert.equal(t.of('inference:held').length, 1, 'the second wake joined the hold, and started none');
      } finally {
        await t.close();
      }
    });
  });

  it('keeps today\'s failure when nothing is pending: compression cannot change it', async () => {
    await withBacklog({ readyAt: 0 }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000), 'the turn fails, as before the hold');
        assert.deepEqual(t.of('inference:held'), []);
        assert.equal(t.of('inference:exhausted')[0]!.errorType, 'over_budget');
        assert.ok(storedText(t.framework).includes('[inference-failed]'), 'the agent gets the failure marker');
      } finally {
        await t.close();
      }
    });
  });

  it('ends the hold when compression has nothing left to do and the context still does not fit', async () => {
    // The maintenance pass at start runs 8 ticks before the turn: the
    // backlog is still pending at the refusal, and done 12 ticks later.
    await withBacklog({ readyAt: 20 }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['nothing_pending']);
        const exhausted = t.of('inference:exhausted')[0]!;
        assert.equal(exhausted.errorType, 'over_budget');
        assert.match(String(exhausted.error), /the turn was held \d+ s while compression ran; compression had nothing left to do and it still didn't fit/);
        assert.equal(t.membrane.calls.length, 0);
      } finally {
        await t.close();
      }
    });
  });

  it('ends the hold at its deadline, and the turn fails as a refused compile did', async () => {
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, holdMs: 400 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['deadline']);
        assert.match(String(t.of('inference:exhausted')[0]!.error), /the turn was held \d+ s while compression ran; the hold's 1 s bound passed and it still didn't fit/);
        assert.equal(t.membrane.calls.length, 0);
      } finally {
        await t.close();
      }
    });
  });

  it('holds a later turn afresh after a hold that ended in failure, and after one that ran', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, holdMs: 400 });
      try {
        // A turn whose hold passes its bound fails ...
        t.send('First');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        // ... and the next turn's refusal holds again, with its own deadline.
        t.send('Second');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2, 5_000), 'a failed turn\'s spent hold does not pass to the next turn');
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        // After a held turn that ran, a later refusal starts a new hold, not
        // the released turn's.
        backlog.fit = false;
        const before = Date.now();
        t.send('Third');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 3, 5_000));
        const third = t.of('inference:held')[2]!;
        assert.ok((third.since as number) >= before, 'its own start, not the released turn\'s');
        assert.ok((third.until as number) >= before + 400);
      } finally {
        await t.close();
      }
    });
  });

  it('runs again when a dry run fails for another reason, and the turn\'s own compile meets it', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        // The context now fits, but the check's dry run fails for another
        // reason: the hold doesn't call that a fit, and lets the turn's
        // compile find out.
        backlog.dryRunError = new Error('store read failed');
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['check_failed']);
        assert.equal(backlog.dryRunError, undefined, 'the dry run met the error');
        assert.ok(JSON.stringify(t.membrane.calls[0]).includes('[budget-hold]'), 'the turn that ran says why it waited');
      } finally {
        await t.close();
      }
    });
  });

  it('paces compression with the maintenance timer off: the drain kick runs again until it fits', async () => {
    await withBacklog({ fitAt: 20 }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 0, recheckMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000),
          'the kick goes on past its 8 ticks while compression is pending');
        assert.ok(backlog.ticks >= 20);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
      } finally {
        await t.close();
      }
    });
  });

  it('with the maintenance timer off, a backlog that never moves costs a kick an interval, not a loop', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 0, recheckMs: 100 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        await new Promise((r) => setTimeout(r, 550));
        // The first kick at once, then one an interval: about 6 in 550 ms.
        assert.ok(backlog.ticks <= 8 * 8, `${backlog.ticks} ticks in 550 ms`);
        assert.ok(backlog.dryRuns <= 8, `${backlog.dryRuns} dry runs in 550 ms`);
        assert.ok(backlog.ticks >= 16, 'it does kick again');
      } finally {
        await t.close();
      }
    });
  });

  it('with the maintenance timer off and the provider gate closed, looks again an interval later', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 0, recheckMs: 50 });
      const open = t.internal.providerGateBlocked.bind(t.framework);
      let blocked = true;
      t.internal.providerGateBlocked = (name: string) => (name === 'prime' && blocked) || open(name);
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(backlog.ticks, 0, 'no kick while the gate is closed: its calls would park there');
        backlog.fit = true;
        blocked = false;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000),
          'the hold looked again once an interval passed');
      } finally {
        await t.close();
      }
    });
  });

  it('leaves the held agent idle: its status shows the hold, and a surgery is admitted and looks again', async () => {
    await withBacklog({}, async (backlog) => {
      // One maintenance pass at start, then none for an hour: only the
      // surgery can bring the release check.
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => !t.internal.activeTurnTokens.has('prime'), 3_000), 'no turn token is kept for the held turn');
        const agents = (t.framework.healthSnapshot() as { agents: Array<{ name: string; budgetHold: Record<string, unknown> | null }> }).agents;
        const hold = agents.find((a) => a.name === 'prime')!.budgetHold;
        assert.ok(hold, 'the status names the hold');
        assert.equal(hold!.errorType, 'over_budget');
        assert.equal(hold!.heldRequests, 1);
        backlog.fit = true;
        await t.framework.switchBranch('main');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000),
          'the surgery brought the release check forward');
        assert.equal(heldRequests(t.framework), undefined);
      } finally {
        await t.close();
      }
    });
  });

  it('sets aside a dry run that was running when a surgery asked to look again', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => backlog.ticks >= 16 && !t.internal.activeTurnTokens.has('prime'), 3_000));
        // A dry run starts, decides it doesn't fit, and is held there.
        let release!: () => void;
        backlog.dryRunGate = new Promise<void>((resolve) => { release = resolve; });
        const dryRuns = backlog.dryRuns;
        (t.framework as unknown as { checkBudgetHolds: () => void }).checkBudgetHolds();
        assert.ok(await pollUntil(() => backlog.dryRuns === dryRuns + 1, 2_000));
        // The context now fits, and a surgery asks to look again.
        backlog.fit = true;
        await t.framework.switchBranch('main');
        backlog.dryRunGate = undefined;
        release();
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000),
          'the stale verdict was set aside, and a fresh dry run released the turn');
        assert.ok(backlog.dryRuns >= dryRuns + 2);
      } finally {
        await t.close();
      }
    });
  });

  it('looks again after an undo', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => backlog.ticks >= 16 && !t.internal.activeTurnTokens.has('prime'), 3_000));
        backlog.fit = true;
        const undone = t.framework.undoLastTurn('prime');
        assert.equal(undone.undone, true, 'the refused start left a checkpoint to undo');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000),
          'the undo brought the release check forward');
      } finally {
        await t.close();
      }
    });
  });

  it('holds a released turn again with its first refusal\'s start and deadline when its own compile still refuses', async () => {
    // The dry run fits at once, but the turn's compile refuses twice more,
    // as a compile with injections can where the dry run fits.
    const proto = ContextManager.prototype as unknown as Patchable;
    const original = { compile: proto.compile, tick: proto.tick, isReady: proto.isReady };
    let refusals = 0;
    proto.compile = async function (this: unknown, ...args: unknown[]) {
      const dryRun = (args[2] as { dryRun?: boolean } | undefined)?.dryRun === true;
      if (!dryRun && refusals < 3) {
        refusals++;
        throw Object.assign(new Error('Compile plan would exceed hard budget: budget=48568'), { name: 'OverBudgetError', budget: 48_568, actual: 49_000 });
      }
      return original.compile.apply(this, args);
    };
    proto.tick = async function () {};
    proto.isReady = function () { return false; };
    try {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        const held = t.of('inference:held');
        assert.equal(held.length, 3, 'each refusal of the released turn held it again');
        assert.ok(held.every((e) => e.since === held[0]!.since), 'with the first refusal\'s start');
        assert.ok(held.every((e) => e.until === held[0]!.until), 'and its deadline');
        assert.deepEqual(t.of('inference:exhausted'), []);
      } finally {
        await t.close();
      }
    } finally {
      Object.assign(proto, original);
    }
  });

  it('fails a released turn refused after its hold\'s deadline, rather than holding it afresh', async () => {
    const proto = ContextManager.prototype as unknown as Patchable;
    const original = { compile: proto.compile, tick: proto.tick, isReady: proto.isReady };
    // The dry run fits, but the released turn's compile starts only after
    // the deadline (a slow queue), and refuses.
    let real = 0;
    proto.compile = async function (this: unknown, ...args: unknown[]) {
      const dryRun = (args[2] as { dryRun?: boolean } | undefined)?.dryRun === true;
      if (dryRun) return original.compile.apply(this, args);
      if (++real === 2) await new Promise((r) => setTimeout(r, 500));
      throw Object.assign(new Error('Compile plan would exceed hard budget: budget=48568'), { name: 'OverBudgetError', budget: 48_568, actual: 49_000 });
    };
    proto.tick = async function () {};
    proto.isReady = function () { return false; };
    try {
      const t = await residentTurn({ maintenanceIntervalMs: 50, holdMs: 300 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        assert.equal(t.of('inference:held').length, 1, 'no second hold past the first one\'s deadline');
        assert.match(String(t.of('inference:exhausted')[0]!.error), /the hold's 1 s bound passed and it still didn't fit/);
      } finally {
        await t.close();
      }
    } finally {
      Object.assign(proto, original);
    }
  });

  it('leaves an ephemeral run to fail as before: its caller is waiting', async () => {
    await withBacklog({}, async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'budget-hold-eph-'));
      const framework = await AgentFramework.create({
        storePath: join(tempDir, 'store'),
        membrane: new MockMembrane().asMembrane(),
        agents: [],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 50,
        errorPolicy: { maxRetries: 3, onInferenceError: (_error, _agent, attempt) => (attempt < 3 ? { retry: true, delayMs: 0 } : { retry: false }) },
      });
      const traces: TraceEvent[] = [];
      framework.onTrace((e) => traces.push(e));
      try {
        const { agent, contextManager } = await framework.createEphemeralAgent({
          name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
        });
        contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
        const run = framework.runEphemeralToCompletion(agent, contextManager);
        framework.start();
        // Bounded, so a run that holds fails here rather than hanging the file.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bound = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('the run was still waiting after 5 s')), 5_000);
        });
        try {
          await assert.rejects(Promise.race([run, bound]), /exceed hard budget/);
        } finally {
          clearTimeout(timer);
        }
        assert.deepEqual(traces.filter((e) => e.type === 'inference:held'), []);
      } finally {
        await framework.stop();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('drops the hold, its requests and what it left for the name, at stop and at disposal', async () => {
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      let closed = false;
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        await t.close();
        closed = true;
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.deepEqual(t.internal.pendingRequests.filter((r) => r.agentName === 'prime'), [], 'the held request went with the stop');
        assert.equal(t.membrane.calls.length, 0);
        for (const map of [t.internal.budgetHolds, t.internal.budgetHoldCarry, t.internal.budgetHoldSpent, t.internal.budgetHoldNotes]) {
          assert.equal(map.size, 0);
        }
      } finally {
        if (!closed) await t.close();
      }
    });
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, holdMs: 300 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        t.internal.budgetHoldSpent.set('prime', { outcome: 'deadline', waitedMs: 1 });
        t.internal.disposeConversationAgent('prime');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.equal(t.internal.budgetHolds.size, 0);
        assert.equal(t.internal.budgetHoldSpent.size, 0, 'a later agent of the name starts with none of it');
        // Past the hold's deadline: nothing is queued for an agent that's gone.
        await new Promise((r) => setTimeout(r, 450));
        assert.deepEqual(t.internal.pendingRequests.filter((r) => r.agentName === 'prime'), []);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
      } finally {
        await t.close();
      }
    });
  });
});
