/**
 * A step of stop() that throws doesn't end the teardown: every later step
 * still runs, and stop() fails with the step's error once it has (F73).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Module, ProcessEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, HeldStream, MockMembrane } from './helpers/mock-membrane.js';

type Internals = {
  livenessWatchdog: unknown;
  ownedStoreClosed: boolean;
  queue: { isClosed: boolean; close(): void };
  retryWaitWakers: Set<() => void>;
  codeExecution: unknown;
  deferredMessages: unknown[];
  [field: string]: unknown;
};
const internals = (framework: AgentFramework) => framework as unknown as Internals;
const diagnosed = () => (AgentFramework as unknown as { diagnosed: Set<AgentFramework> }).diagnosed;

/** An object whose `method` throws `error`, every other method doing
 *  nothing: it stands in for a part a plain framework doesn't build. */
function throwingStub(method: string, error: Error): object {
  return new Proxy({}, {
    get: (_target, prop) => (prop === 'then' ? undefined : prop === method ? () => { throw error; } : () => {}),
  });
}

/** Makes `owner[field].method` throw, building a stub when the framework has
 *  no such part; returns what undoes it. */
function throwIn(owner: Record<string, unknown>, field: string, method: string, error: Error): () => void {
  const part = owner[field] as Record<string, unknown> | null | undefined;
  if (!part) {
    owner[field] = throwingStub(method, error);
    return () => { owner[field] = null; };
  }
  const original = part[method];
  part[method] = () => { throw error; };
  return () => { part[method] = original; };
}

function recordingModule(onStop?: () => void) {
  const calls: string[] = [];
  const module: Module = {
    name: 'events',
    async start() { calls.push('start'); },
    async stop() { calls.push('stop'); onStop?.(); },
    getTools: () => [],
    async handleToolCall() { return { success: true }; },
    async onProcess(event) {
      if (event.type !== 'external-message') return {};
      return {
        addMessages: [{ participant: 'User', content: [{ type: 'text', text: String((event as { content?: unknown }).content) }] }],
        requestInference: true,
      };
    },
  };
  return { module, calls };
}

/** A framework with a module, a stand-in watchdog that records its stop, and
 *  an ephemeral run whose wake the loop hasn't taken up, so that only stop()'s
 *  sweep ends it. */
async function frameworkToStop(t: import('node:test').TestContext, membrane = new MockMembrane(), onStop?: () => void) {
  const dir = mkdtempSync(join(tmpdir(), 'stop-step-throws-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { module, calls } = recordingModule(onStop);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(), syncIntervalMs: 0, maintenanceIntervalMs: 0,
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }], modules: [module],
  });
  const watchdog = { stopped: false, stops: 0, stop() { this.stopped = true; this.stops++; } };
  internals(framework).livenessWatchdog = watchdog;
  const { agent, contextManager } = await framework.createEphemeralAgent({
    name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
  });
  contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
  const startRun = () => {
    const run = framework.runEphemeralToCompletion(agent, contextManager, { startupTimeoutMs: 30_000 });
    let ended: unknown;
    run.catch((error: unknown) => { ended = error; });
    return () => ended;
  };
  return { framework, calls, watchdog, startRun };
}

/** stop()'s failure is the step's error, alone or among others. */
function failedWith(failure: unknown, error: Error): boolean {
  return failure === error || (failure instanceof AggregateError && failure.errors.includes(error));
}

interface Row {
  step: string;
  inject(framework: AgentFramework, error: Error): () => void;
  /** The check that is this step's own, which its throw keeps from holding. */
  own?: 'watchdog' | 'queue';
  /** A step after everything stop() started has stopped: the store closes. */
  finishing?: boolean;
  /** A further check of the step's own, once stop() has settled. */
  check?(framework: AgentFramework): void;
}

/** The releases whose unread pass ran, in the unread pass's row. */
const unreadPassed: string[] = [];
/** The waiting outgoing completes that went out, in their row. */
const sentCompletes: string[] = [];

/**
 * Two releases a quiesce postponed, the first one's pass throwing, set before
 * stop() for its first pass, or while it waits (from the liveness watchdog's
 * stop(), which runs between its two passes) for its pass after the waits.
 * Other agents, such as the run whose end releases its window, read their
 * unread notices as usual.
 */
function postponedReleases(framework: AgentFramework, error: Error, when: 'before stop()' | 'while stop() waits'): () => void {
  unreadPassed.length = 0;
  const releases = internals(framework).releasesAfterResume as Map<string, { name: string }>;
  const postpone = () => {
    releases.set('first', { name: 'first' });
    releases.set('second', { name: 'second' });
  };
  const watchdog = internals(framework).livenessWatchdog as { stop(): void };
  const stop = watchdog.stop;
  if (when === 'before stop()') postpone();
  else watchdog.stop = function (this: unknown) { postpone(); return stop.call(this); };
  const owner = framework as unknown as Record<string, unknown>;
  const usual = (owner.releasedWindow as (agent: unknown, held: Set<string>) => unknown).bind(framework);
  owner.releasedWindow = (agent: { name: string }, held: Set<string>) => {
    if (agent.name === 'first') throw error;
    if (agent.name !== 'second') return usual(agent, held);
    unreadPassed.push(agent.name);
    return { unread: [], held: new Map() };
  };
  return () => { delete owner.releasedWindow; watchdog.stop = stop; };
}

function checkPostponedReleases(framework: AgentFramework): void {
  assert.deepEqual(unreadPassed, ['second'], "the other release's unread pass still ran");
  assert.equal((internals(framework).releasesAfterResume as Map<string, unknown>).size, 0, 'the postponed releases are cleared');
}

const ROWS: Row[] = [
  { step: "the push coalescer's suspend()", inject: (fw, e) => throwIn(internals(fw), 'pushCoalescer', 'suspend', e) },
  { step: 'flushing the coalescing snapshot', inject: (fw, e) => patchMethod(fw, 'flushCoalescingSnapshot', e) },
  { step: 'acking deferred writes', inject: (fw, e) => patchMethod(fw, 'ackDeferredWrites', e) },
  {
    step: "a retry wait's waker",
    inject: (fw, e) => {
      const wake = () => { throw e; };
      internals(fw).retryWaitWakers.add(wake);
      return () => { internals(fw).retryWaitWakers.delete(wake); };
    },
  },
  { step: 'closing the queue', own: 'queue', inject: (fw, e) => throwIn(internals(fw), 'queue', 'close', e) },
  { step: "the tune-out coordinator's stop()", inject: (fw, e) => throwIn(internals(fw), 'tuneOutCoordinator', 'stop', e) },
  {
    step: "code_execution's scripts' dispose()",
    inject: (fw, e) => {
      internals(fw).codeExecution = { scripts: throwingStub('dispose', e) };
      return () => { internals(fw).codeExecution = null; };
    },
  },
  { step: "cancelling provider admission", inject: (fw, e) => patchMethod(fw, 'cancelProviderAdmission', e) },
  {
    step: "a stream's waiting outgoing complete",
    inject: (fw, e) => {
      // Two streams' completes wait: the first one's throws.
      sentCompletes.length = 0;
      const waiting = internals(fw).pendingOutgoingCompletes as Set<() => void>;
      const first = () => { throw e; };
      const second = () => { sentCompletes.push('second'); };
      waiting.add(first);
      waiting.add(second);
      return () => { waiting.delete(first); waiting.delete(second); };
    },
    check: () => assert.deepEqual(sentCompletes, ['second'], "the other stream's complete still went out"),
  },
  {
    step: "a postponed release's unread pass, before the registry forgets its channels",
    inject: (fw, e) => postponedReleases(fw, e, 'before stop()'),
    check: (fw) => checkPostponedReleases(fw),
  },
  {
    step: "the drain of what was queued for a postponed release, before the registry forgets its channels",
    inject: (fw, e) => {
      (internals(fw).releasesAfterResume as Map<string, { name: string }>).set('first', { name: 'first' });
      const owner = fw as unknown as Record<string, unknown>;
      const usual = (owner.readdDrained as (...args: unknown[]) => unknown).bind(fw);
      owner.readdDrained = (...args: unknown[]) => {
        if (args[1] === 'stop: postponed releases') throw e;
        return usual(...args);
      };
      return () => { delete owner.readdDrained; };
    },
    check: (fw) => assert.equal((internals(fw).releasesAfterResume as Map<string, unknown>).size, 0, 'the postponed releases are cleared'),
  },
  { step: "the channel registry's stopAll()", inject: (fw, e) => throwIn(internals(fw), 'channelRegistry', 'stopAll', e) },
  { step: "the event gate's dispose()", inject: (fw, e) => throwIn(internals(fw), 'eventGate', 'dispose', e) },
  {
    step: "the watchdog's stop()",
    own: 'watchdog',
    inject: (fw, e) => {
      const watchdog = internals(fw).livenessWatchdog as { stop(): void };
      const original = watchdog.stop;
      watchdog.stop = () => { throw e; };
      return () => { watchdog.stop = original; };
    },
  },
  {
    step: "a postponed release's unread pass, after the waits",
    finishing: true,
    inject: (fw, e) => postponedReleases(fw, e, 'while stop() waits'),
    check: (fw) => checkPostponedReleases(fw),
  },
  {
    step: 'the last flush of deferred writes',
    finishing: true,
    inject: (fw, e) => {
      // The resident's, not the run's: the run's own end stores its queue.
      internals(fw).deferredMessages.push({ forAgent: 'assistant' });
      return patchMethod(fw, 'readdDrained', e);
    },
  },
];

/** Makes the framework's own `method` throw; returns what undoes it. */
function patchMethod(framework: AgentFramework, method: string, error: Error): () => void {
  const owner = framework as unknown as Record<string, unknown>;
  owner[method] = () => { throw error; };
  return () => { delete owner[method]; };
}

describe('a step of stop() that throws', () => {
  for (const row of ROWS) {
    it(`${row.step}: every later step still runs, and stop() fails with its error`, async (t) => {
      const { framework, calls, watchdog, startRun } = await frameworkToStop(t);
      const error = new Error(`zz ${row.step} failed`);
      const undo = row.inject(framework, error);
      framework.start();
      const ended = startRun();
      let failure: unknown;
      await framework.stop().catch((e: unknown) => { failure = e; });
      assert.ok(failedWith(failure, error), `stop() fails with the step's error, got ${String(failure)}`);
      assert.deepEqual(calls, ['start', 'stop'], 'the module was stopped');
      if (row.own !== 'watchdog') assert.equal(watchdog.stopped, true, 'the watchdog was stopped');
      if (row.own !== 'queue') assert.equal(internals(framework).queue.isClosed, true, 'the queue was closed');
      assert.equal(diagnosed().has(framework), false, 'the framework left the diagnostics registry');
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(String(ended()), /refused: the framework is stopping/, "stop()'s sweep ended the pending ephemeral run");
      row.check?.(framework);
      if (row.finishing) {
        assert.equal(internals(framework).ownedStoreClosed, true, 'a step that finishes the stop leaves the store to close');
        return;
      }
      assert.equal(internals(framework).ownedStoreClosed, false, 'the store stays open for another stop()');
      undo();
      await framework.stop();
      assert.equal(internals(framework).ownedStoreClosed, true, 'another stop() closes the store');
    });
  }

  it("a resident's stream whose cancel() throws is left running: stop() fails with that error without waiting for it, and a later stop() waits for it", async (t) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    t.after(() => release());
    const error = new Error("zz the stream's cancel failed");
    let cancels = 0;
    class CancelThrows extends HeldStream {
      // A host's stream whose cancel always throws, and which runs until the
      // test releases it.
      override cancel(): void {
        cancels++;
        throw error;
      }
    }
    const membrane = new MockMembrane();
    membrane.streamYielding = (request) => {
      membrane.calls.push(request);
      return new CancelThrows(released, [createMockResponse([{ type: 'text', text: 'resident done' }])]);
    };
    const { framework, calls, watchdog, startRun } = await frameworkToStop(t, membrane);
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} } as unknown as ProcessEvent);
    // stop()'s wait on streams reads activeStreams, which holds a stream's
    // handle once the stream is being driven.
    const activeStreams = internals(framework).activeStreams as Map<string, unknown>;
    for (let waited = 0; !activeStreams.has('assistant'); waited += 10) {
      assert.ok(waited < 10_000, "the resident's stream is being driven");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // A write for the resident, deferred behind its stream.
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'a note for later', metadata: {} } as unknown as ProcessEvent);
    for (let waited = 0; internals(framework).deferredMessages.length === 0; waited += 10) {
      assert.ok(waited < 10_000, 'the note is deferred behind the stream');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ended = startRun();
    // No budget, as connectome-host stops a framework. The stream runs until
    // the test releases it, so a stop() that waited for it wouldn't settle.
    const first = await settlesWithin(framework.stop(), 10_000);
    assert.notEqual(first, 'still waiting', "stop() doesn't wait for a stream whose cancel threw");
    assert.ok(failedWith(first, error), `stop() fails with the cancel's error, got ${String(first)}`);
    assert.deepEqual(calls, ['start', 'stop'], 'the module was stopped');
    assert.equal(watchdog.stopped, true, 'the watchdog was stopped');
    assert.equal(diagnosed().has(framework), false, 'the framework left the diagnostics registry');
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(String(ended()), /refused: the framework is stopping/, "stop()'s sweep ended the pending ephemeral run");
    assert.equal(internals(framework).ownedStoreClosed, false, 'the store stays open while the stream runs');
    assert.equal(internals(framework).deferredMessages.length, 1, "the resident's deferred write stays queued while its stream runs");
    // A later stop() waits for the stream the first one left running: its own
    // cancel has run (and thrown), and it hasn't reached the watchdog's stop,
    // which comes after the waits.
    const later = framework.stop();
    assert.equal(await settlesWithin(later, 200), 'still waiting', 'a later stop() waits for the stream');
    assert.equal(cancels, 2, "the later stop()'s cancel ran");
    assert.equal(watchdog.stops, 1, 'the later stop() is still at its waits');
    release();
    // Its own cancel threw too, so it fails as the first did and keeps the
    // store open. Once the stream has ended, its agent holds no stream, so a
    // stop() makes no cancel and closes the store.
    const second = await later.then(() => 'resolved', (e: unknown) => e);
    assert.ok(failedWith(second, error), `the later stop() fails with the cancel's error, got ${String(second)}`);
    assert.equal(watchdog.stops, 2, 'the later stop() went on once the stream ended');
    assert.equal(internals(framework).ownedStoreClosed, false);
    await framework.stop();
    assert.equal(cancels, 2, 'no cancel once the stream has ended');
    assert.equal(internals(framework).ownedStoreClosed, true, 'once the stream has ended, a stop() closes the store');
  });

  it("an ephemeral run whose own stream's cancel() throws still leaves when stop() ends it, with stop()'s reason, and its stream's late text reaches no context", async (t) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    t.after(() => release());
    const error = new Error("zz the worker stream's cancel failed");
    class CancelThrows extends HeldStream {
      override cancel(): void {
        throw error;
      }
    }
    const membrane = new MockMembrane();
    membrane.streamYielding = (request) => {
      membrane.calls.push(request);
      return new CancelThrows(released, [createMockResponse([{ type: 'text', text: 'late words' }])]);
    };
    const dir = mkdtempSync(join(tmpdir(), 'stop-step-throws-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: membrane.asMembrane(), syncIntervalMs: 0, maintenanceIntervalMs: 0,
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }], modules: [],
    });
    framework.start();
    const { agent, contextManager } = await framework.createEphemeralAgent({
      name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
    });
    contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
    const run = framework.runEphemeralToCompletion(agent, contextManager, { startupTimeoutMs: 30_000 });
    run.catch(() => {});
    const activeStreams = internals(framework).activeStreams as Map<string, unknown>;
    for (let waited = 0; !activeStreams.has('worker'); waited += 10) {
      assert.ok(waited < 10_000, "the worker's stream is being driven");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const first = await settlesWithin(framework.stop(), 10_000);
    assert.ok(failedWith(first, error), `stop() fails with the cancel's error, got ${String(first)}`);
    // The run's end cancels the stream again, and that cancel throws too.
    assert.match(String(await settlesWithin(run, 10_000)), /refused: the framework is stopping/, "the run ended, and its outcome says why");
    assert.ok(logged.some((line) => line.startsWith(
      "[ephemeral] agent=worker its stream's cancel failed at the run's end; the run leaves all the same:")), logged.join('\n'));
    assert.equal((internals(framework).ephemeralRuns as Map<string, unknown>).has('worker'), false, 'the run left');
    assert.equal((internals(framework).agents as Map<string, unknown>).has('worker'), false, 'its agent left');
    // The stream runs on until released, and stop() left it running.
    const leftRunning = [...(internals(framework).leftRunning as Map<Promise<unknown>, unknown>).keys()];
    assert.equal(leftRunning.length, 1, "stop() left the worker's stream running");
    release();
    await Promise.allSettled(leftRunning);
    assert.equal(JSON.stringify(contextManager.getAllMessages()).includes('late words'), false,
      "the stream's late text reaches no context, the worker's own included");
    await framework.stop();
    assert.equal(internals(framework).ownedStoreClosed, true, 'once the stream has ended, a stop() closes the store');
  });
});

/** What `settling` came to within `ms`: 'resolved', its rejection, or 'still waiting'. */
function settlesWithin(settling: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    settling.then(() => 'resolved', (error: unknown) => error),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms)),
  ]);
}

describe("stop()'s waits on the tool-result guard's annotations", () => {
  /** Adds an annotation as the guard's host tracks one: it leaves the set as
   *  it settles. An annotation never rejects (ToolResultGuard); these waits
   *  don't rest on that. */
  function annotate(framework: AgentFramework, annotation: Promise<void>): void {
    const annotations = internals(framework).guardAnnotations as Set<Promise<void>>;
    annotations.add(annotation);
    const leave = () => { annotations.delete(annotation); };
    annotation.then(leave, leave);
  }

  it('an annotation that rejects while stop() waits settles the wait before the modules stop, and the teardown goes on', async (t) => {
    const { framework, calls, watchdog } = await frameworkToStop(t);
    let fail!: (error: Error) => void;
    let finish!: () => void;
    annotate(framework, new Promise((_resolve, reject) => { fail = reject; }));
    annotate(framework, new Promise((resolve) => { finish = () => { calls.push('annotation done'); resolve(); }; }));
    // The watchdog's stop is the step just before the wait. From there, the
    // timers fire once the wait has begun: one annotation rejects, and the
    // other ends after it.
    const stopWatchdog = watchdog.stop.bind(watchdog);
    watchdog.stop = () => {
      stopWatchdog();
      setTimeout(() => fail(new Error('zz an annotation failed')), 0);
      setTimeout(finish, 20);
    };
    await framework.stop();
    assert.deepEqual(calls, ['start', 'annotation done', 'stop'], 'every annotation settled before the modules stopped');
    assert.equal(internals(framework).ownedStoreClosed, true);
  });

  it('one that a module starts and that rejects while stop() waits settles the wait before the final sync, and the store closes', async (t) => {
    let framework!: AgentFramework;
    let calls!: string[];
    const built = await frameworkToStop(t, new MockMembrane(), () => {
      // Started as the module stops; its timer fires once stop() has reached
      // its second wait, which follows the modules' stop with no timer of its
      // own between.
      const late = new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error('zz a late annotation failed')), 0);
      });
      late.catch(() => { calls.push('annotation settled'); });
      annotate(framework, late);
    });
    framework = built.framework;
    calls = built.calls;
    // Each store sync from here on, in the same list.
    const store = framework.getStore();
    const sync = store.sync.bind(store);
    store.sync = () => { calls.push('sync'); sync(); };
    await framework.stop();
    assert.deepEqual(calls.filter((call) => call !== 'sync'), ['start', 'stop', 'annotation settled']);
    assert.ok(calls.lastIndexOf('sync') > calls.indexOf('annotation settled'), `the final sync after the annotation settled: ${JSON.stringify(calls)}`);
    assert.equal(internals(framework).ownedStoreClosed, true, 'the store closed');
  });
});
