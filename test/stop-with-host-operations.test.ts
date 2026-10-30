/**
 * stop() and an operator's operations.
 *
 * Once stop() has begun, an operator's entry points refuse: quiesce, resume,
 * the store surgeries, a branch switch, undo, redo, maintain, puppet, the
 * awareness sync and the MCPL lifecycle calls (a host/command is refused by
 * its listener). The marks' delivery a surgery starts isn't one of these
 * operations: stop() doesn't wait for it as one, and starts none once it has
 * begun. A branch move starts none at all: marks are one-shot.
 * These tests cover those refusals and the operations admitted before them, over
 * MCPL or from a direct call: stop() waits for each, and for what each starts
 * while it waits, before the event gate, the modules, the MCPL connections
 * and the store go. A budget can cut that wait short, leaving the store open.
 *
 * Where a test holds an operation open, it lets it go once stop() reads a
 * nonempty set of operations to wait on, or reaches its modules' teardown.
 * main reaches teardown without reading any such set, so the order of the
 * two events is the verdict, and it doesn't depend on timing.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventResponse, Module, ModuleContext, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, OperatorActionError, ShutdownTimeoutError } from '../src/index.js';
import { ApiServer } from '../src/api/server.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** Resolve once `cond` holds; fail, naming `what`, after `ms`. */
async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Records when stop() reaches its modules' teardown, which comes after its wait for operations. */
class TeardownProbe implements Module {
  readonly name = 'teardown-probe';
  constructor(private readonly order: string[]) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> { this.order.push('modules stopped'); }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(): Promise<EventResponse> { return {}; }
}

/** The private state these tests set up or hold. */
interface Internals {
  activeTurnTokens: Map<string, number>;
  maintenancePass: Promise<unknown> | null;
  mcplServerRegistry: unknown;
  readDiscordAwarenessDue(serverId?: string): unknown[];
  drainDiscordAwarenessOutbox(serverId: string): Promise<unknown>;
  deliverDiscordAwarenessInBackground(occasion: string, agentName: string): void;
  flushDeferredWrites(label: string): Promise<void>;
  wireMcplEvents(connection: unknown, config: { id: string }): void;
  operatorOperations: Set<{ label: string; promise: Promise<void> }>;
  moduleRegistry: { getModule(name: string): unknown };
  saveTurnCheckpoints(name: string, checkpoints: unknown[]): void;
  getTurnCheckpoints(name: string): unknown[];
}
const internals = (framework: AgentFramework): Internals => framework as unknown as Internals;

describe('stop() with an operator operation in flight', () => {
  let tempDir: string;
  let storePath: string;
  let logged: string[];
  let rejections: unknown[];
  let order: string[];
  let waitReads: number;
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  const consoleError = console.error;
  const consoleWarn = console.warn;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'af-stop-host-ops-'));
    storePath = join(tempDir, 'store');
    logged = [];
    rejections = [];
    order = [];
    waitReads = 0;
    process.on('unhandledRejection', onRejection);
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  });

  afterEach(() => {
    console.error = consoleError;
    console.warn = consoleWarn;
    process.off('unhandledRejection', onRejection);
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function create(): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      modules: [new TeardownProbe(order)],
    });
    internals(framework).operatorOperations = new class extends Set<{ label: string; promise: Promise<void> }> {
      override [Symbol.iterator](): SetIterator<{ label: string; promise: Promise<void> }> {
        if (this.size > 0) waitReads++;
        return super[Symbol.iterator]();
      }
    }();
    return framework;
  }

  /** A positive observation releases the hold. Main reaches module teardown
   * without reading the set, making the wrong order observable too. */
  async function releaseWhenStopWaits(release: () => void): Promise<void> {
    try {
      await until(() => waitReads > 0 || order.includes('modules stopped'),
        'stop to read pending operations or stop its modules', 30_000);
    } finally { release(); }
  }

  /** Every delivery pass finds work due for one server and waits at that
   * server's drain until released, as a drain whose request Discord hasn't
   * answered does. `started` counts the drains passes reached. */
  function holdDrains(framework: AgentFramework): { started(): number; release(): void } {
    let started = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fw = internals(framework);
    fw.readDiscordAwarenessDue = () => [{ serverId: 'srv' }];
    fw.drainDiscordAwarenessOutbox = async () => {
      started++;
      await held;
      return { status: 'delivered', delivered: 1, failed: 0 };
    };
    return { started: () => started, release: () => release() };
  }

  async function bootsQuiesced(): Promise<boolean> {
    const restarted = await create();
    try {
      return restarted.getHostModeStatus().quiesced;
    } finally {
      await restarted.stop();
    }
  }

  it('a quiesce waiting for its drain stops waiting when stop() begins, and stop() waits for it', { timeout: 20_000 }, async () => {
    const framework = await create();
    framework.start();
    // A turn between dequeue and stream registration holds its token with no
    // stream to cancel. Stop cuts the drain short; the token remains alive.
    const tokens = internals(framework).activeTurnTokens;
    tokens.set('agent', -1);
    let settled = false;
    const traces: string[] = [];
    framework.onTrace((event) => { traces.push(event.type); });
    const quiescing = framework.quiesce({ reason: 'surgery', timeoutMs: 600_000 });
    void quiescing.then(() => { settled = true; }, () => { settled = true; });
    const stopping = framework.stop();
    try {
      await until(() => settled || order.includes('modules stopped'), 'stop to interrupt the quiesce or reach teardown', 10_000);
      await stopping;
      assert.equal(settled, true, 'stop() returned while the quiesce was still waiting');
      const status = await quiescing;
      assert.equal(status.quiesced, true);
      assert.equal(status.drained, false);
      assert.ok(!traces.includes('host:quiesce'), 'an interrupted drain reports no completed quiesce');
      assert.ok(logged.some((line) => line.includes('quiesce stopped waiting for its drain: the framework is stopping')), logged.join('\n'));
    } finally {
      tokens.delete('agent');
      await quiescing.catch(() => {});
      await stopping;
    }
    assert.equal(await bootsQuiesced(), true, 'the host boots quiesced');
    assert.deepEqual(rejections, []);
  });

  it("an abandon waiting on a turn it can't cancel stops waiting when stop() begins, and stop() waits for it", { timeout: 20_000 }, async () => {
    const framework = await create();
    framework.start();
    const tokens = internals(framework).activeTurnTokens;
    tokens.set('agent', -1);
    let settled = false;
    const quiescing = framework.quiesce({ timeoutMs: 1_000, abandon: true });
    void quiescing.then(() => { settled = true; }, () => { settled = true; });
    try {
      // After its one-second window, abandon finds no stream to cancel and
      // gives the turn ten seconds to settle on its own.
      await until(() => logged.some((line) => line.includes('cannot abandon turn for agent')), 'abandon to find the held token');
      const began = Date.now();
      await framework.stop();
      const took = Date.now() - began;
      assert.equal(settled, true, 'stop() returned while the abandon was still waiting');
      // Only waiting out the ten-second grace should consume this bound.
      assert.ok(took < 8_000, `stop() took ${took} ms, waiting out the abandon's ten seconds`);
      assert.deepEqual((await quiescing).unabandonable, ['agent']);
    } finally {
      tokens.delete('agent');
      await quiescing.catch(() => {});
    }
    assert.deepEqual(rejections, []);
  });

  it('a resume waiting when stop() begins refuses, and the host stays quiesced', async () => {
    const framework = await create();
    framework.start();
    await framework.quiesce({ reason: 'surgery' });
    // resume() waits for a running maintenance pass before its feasibility
    // gate, and so does stop(): both go on when the pass ends.
    let endPass!: () => void;
    internals(framework).maintenancePass = new Promise<void>((resolve) => { endPass = resolve; });
    const resuming = framework.resume();
    const stopping = framework.stop();
    endPass();
    await assert.rejects(resuming, /^Error: resume refused: the framework is stopping, so the host stays quiesced$/);
    await stopping;
    assert.equal(await bootsQuiesced(), true, 'the host boots quiesced');
    assert.deepEqual(rejections, []);
  });

  it('a quiesce called after stop() is refused, and persists nothing', async () => {
    const framework = await create();
    await framework.stop();
    await assert.rejects(framework.quiesce({ reason: 'too late' }), /^Error: quiesce refused: the framework is stopping$/);
    assert.equal(await bootsQuiesced(), false, 'the host boots serving');
  });

  it('a resume called after stop() is refused, and the host stays quiesced', async () => {
    const framework = await create();
    await framework.quiesce();
    await framework.stop();
    await assert.rejects(framework.resume(), /^Error: resume refused: the framework is stopping$/);
    assert.equal(await bootsQuiesced(), true, 'the host boots quiesced');
  });

  it('stop() waits for a resume past its commit point: it completes, its durable clear lands, and its data plane opens', async () => {
    const framework = await create();
    const connection = {
      id: 'srv',
      isConnected: true,
      readied: 0,
      stopReconnecting(): void {},
      pauseDataPlane(): void {},
      readyControlPlane(): void {},
      ready(): void { this.readied++; },
    };
    const fw = internals(framework);
    fw.mcplServerRegistry = { getAllServers: () => [connection], closeAll: async () => {} };
    framework.start();
    await framework.quiesce();
    // Past its commit point, the resume flushes the writes the quiesce held
    // back; that flush is held while stop() waits.
    let flushed: (() => void) | undefined;
    const flush = fw.flushDeferredWrites.bind(framework);
    fw.flushDeferredWrites = (label: string) => new Promise<void>((resolve) => { flushed = () => resolve(flush(label)); });
    const resuming = framework.resume().then((status) => { order.push('resume settled'); return status; });
    await until(() => flushed !== undefined, 'the resume to reach its flush');
    const stopping = framework.stop();
    await releaseWhenStopWaits(() => flushed!());
    await stopping;
    assert.deepEqual(order, ['resume settled', 'modules stopped']);
    assert.equal((await resuming).quiesced, false, 'past its commit point the resume completes');
    assert.equal(connection.readied, 1, 'its data plane opens, so the listeners answer what it held back');
    assert.equal(await bootsQuiesced(), false, 'its durable clear landed');
    assert.deepEqual(rejections, []);
  });

  it("stop() waits for a host/command, so its answer goes out before the connections close", async () => {
    const framework = await create();
    const connection = Object.assign(new EventEmitter(), { id: 'srv' });
    internals(framework).wireMcplEvents(connection, { id: 'srv' });
    const cm = framework.getAgent('agent')!.getContextManager();
    for (const n of [1, 2]) {
      cm.addMessage('user', [{ type: 'text', text: `m${n}` }], { serverId: 'srv', channelId: 'discord:g1:c1', messageId: `d${n}` });
    }
    // hide's answer carries a preview of what the agent sees now; hold it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const preview = framework.previewActivation.bind(framework);
    let previewing = false;
    framework.previewActivation = (async (...args: Parameters<AgentFramework['previewActivation']>) => {
      previewing = true;
      await held;
      return preview(...args);
    }) as AgentFramework['previewActivation'];
    const answers: unknown[] = [];
    connection.emit('host-command', { command: 'hide', agentName: 'agent', fromMessageId: 'd1' }, {
      id: 7,
      respond: (result: unknown) => { answers.push(result); order.push('host/command answered'); },
      respondError: (code: number, message: string) => { answers.push({ code, message }); order.push('host/command answered'); },
    });
    await until(() => previewing, 'hide to reach its preview');
    const stopping = framework.stop();
    await releaseWhenStopWaits(release);
    await stopping;
    assert.deepEqual(order, ['host/command answered', 'modules stopped']);
    assert.equal((answers[0] as { ok?: boolean; hidden?: number }).ok, true, JSON.stringify(answers));
    assert.equal((answers[0] as { hidden?: number }).hidden, 1);
    assert.deepEqual(rejections, []);
  });

  it('stop() waits for a store surgery to release the store', async () => {
    const framework = await create();
    const cm = framework.getAgent('agent')!.getContextManager();
    const ids = [1, 2, 3].map((n) => cm.addMessage('user', [{ type: 'text', text: `m${n}` }]));
    // The rollback moves the branch while it holds the store; hold that.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let switching = false;
    const switchBranch = cm.switchBranch.bind(cm);
    cm.switchBranch = async (...args: Parameters<typeof cm.switchBranch>) => {
      switching = true;
      await held;
      const switched = await switchBranch(...args);
      order.push('branch moved');
      return switched;
    };
    const rolling = framework.rollbackToMessage('agent', { messageId: ids[0]! });
    await until(() => switching, 'the rollback to reach its branch move');
    const stopping = framework.stop();
    await releaseWhenStopWaits(release);
    await stopping;
    assert.deepEqual(order, ['branch moved', 'modules stopped']);
    assert.equal((await rolling).messagesRemoved, 2);
    // Its marks' delivery would race the teardown, so it's left to the next start.
    assert.ok(logged.some((line) => line.includes('delivery after rollback agent=agent not started')), logged.join('\n'));
    assert.deepEqual(rejections, []);
  });

  it('stop() waits for an awareness sync already running', async () => {
    const framework = await create();
    const drains = holdDrains(framework);
    const syncing = framework.syncDiscordAwarenessMarkers().then(() => { order.push('awareness synced'); });
    await until(() => drains.started() > 0, 'the sync to wait on its drain');
    const stopping = framework.stop();
    await releaseWhenStopWaits(() => drains.release());
    await stopping;
    await syncing;
    assert.deepEqual(order, ['awareness synced', 'modules stopped']);
    assert.deepEqual(rejections, []);
  });

  it("a stop() called from a trace inside stop()'s own start gets the same attempt, and one teardown runs", async () => {
    const framework = await create();
    const fw = framework as unknown as {
      pushCoalescer: { suspend(): void } | null;
      emitTrace(event: unknown): void;
    };
    // A coalescer with a render in flight reports it from suspend(), the first
    // thing stop() does, as a trace.
    let suspended = false;
    fw.pushCoalescer = {
      suspend: () => {
        if (suspended) return;
        suspended = true;
        fw.emitTrace({ type: 'mcpl:coalescing', phase: 'suspended' });
      },
    };
    // A turn to undo, so an admitted undo would move the branch.
    const record = (framework as unknown as { recordTurnCheckpoint(name: string): void }).recordTurnCheckpoint.bind(framework);
    record('agent');
    framework.getAgent('agent')!.getContextManager().addMessage('user', [{ type: 'text', text: 'a turn' }]);
    const connection = Object.assign(new EventEmitter(), { id: 'srv' });
    internals(framework).wireMcplEvents(connection, { id: 'srv' });
    const drains = holdDrains(framework);
    let inner: Promise<void> | undefined;
    let undoInside: unknown;
    let syncInside: Promise<void> | undefined;
    let hostUndo: unknown;
    framework.onTrace((event) => {
      if ((event as { type?: string }).type !== 'mcpl:coalescing' || inner) return;
      inner = framework.stop();
      // stop() has begun, though its queue isn't closed yet.
      try { framework.undoLastTurn('agent'); } catch (error) { undoInside = error; }
      syncInside = framework.syncDiscordAwarenessMarkers();
      void syncInside.catch(() => {});
      internals(framework).deliverDiscordAwarenessInBackground('probe', 'framework');
      connection.emit('host-command', { command: 'undo', agentName: 'agent', turns: 1 }, {
        respond: (result: unknown) => { hostUndo = { respond: result }; },
        respondError: (code: number, message: string) => { hostUndo = { code, message }; },
      });
    });
    const outer = framework.stop();
    assert.equal(inner, outer, 'the reentrant stop() gets the attempt already running');
    assert.match(String(undoInside), /^Error: undo refused: the framework is stopping$/);
    await assert.rejects(syncInside!, /^Error: awareness sync refused: the framework is stopping$/);
    assert.ok(logged.some((line) => line.includes('delivery after probe agent=framework not started')), logged.join('\n'));
    assert.equal(drains.started(), 0, 'neither the sync nor the delivery started a pass');
    assert.deepEqual(hostUndo, { code: -32000, message: 'the host is stopping' });
    assert.equal(framework.getStore().currentBranch().name, 'main', 'nothing moved the branch');
    await outer;
    assert.deepEqual(order, ['modules stopped'], 'one teardown');
    assert.equal(framework.getStore().isClosed(), true);
    await framework.stop();
    assert.deepEqual(rejections, []);
  });

  it('an awareness sync after a stop() that failed is refused', async () => {
    const framework = await create();
    const fw = framework as unknown as Internals & { codeExecution: unknown };
    // Scripts whose dispose throws fail stop() after the queue has closed,
    // before stop() reaches its wait on the operator set.
    fw.codeExecution = { scripts: { dispose() { throw new Error('dispose failed'); }, turnEnded() {}, leftRunning: () => 0 } };
    await assert.rejects(framework.stop(), /dispose failed/);
    await assert.rejects(framework.syncDiscordAwarenessMarkers(), /^Error: awareness sync refused: the framework is stopping$/);
    fw.codeExecution = null;
    await framework.stop();
    assert.equal(framework.getStore().isClosed(), true);
  });

  it('an awareness sync called once stop() has begun is refused, and starts no pass', async () => {
    const framework = await create();
    const drains = holdDrains(framework);
    let finishModules!: () => void;
    const hold = new Promise<void>((resolve) => { finishModules = resolve; });
    framework.getModule('teardown-probe')!.stop = async () => {
      order.push('modules stopped');
      await hold;
    };
    const stopping = framework.stop();
    try {
      await until(() => order.includes('modules stopped'), 'module teardown');
      await assert.rejects(framework.syncDiscordAwarenessMarkers(), /^Error: awareness sync refused: the framework is stopping$/);
      assert.equal(drains.started(), 0);
    } finally { finishModules(); await stopping; }
    await assert.rejects(framework.syncDiscordAwarenessMarkers(), /^Error: awareness sync refused: the framework is stopping$/);
    assert.equal(drains.started(), 0);
  });

  for (const action of ['rollback', 'suppress'] as const) it('a ' + action + " whose branch move outlasts stop()'s budget still finishes, and leaves its marks' delivery to the next start", { timeout: 20_000 }, async () => {
    // The surgery was admitted before stop() began, so nothing refuses it
    // partway. Its marks' delivery isn't started while the framework stops:
    // the durable outbox keeps them for the next start.
    const framework = await create();
    const cm = framework.getAgent('agent')!.getContextManager();
    const ids = [1, 2, 3].map((n) => cm.addMessage('user', [{ type: 'text', text: 'm' + n }]));
    let finishMove!: () => void;
    const moveHold = new Promise<void>((resolve) => { finishMove = resolve; });
    if (action === 'rollback') {
      const switchBranch = cm.switchBranch.bind(cm);
      cm.switchBranch = async (...args: Parameters<typeof cm.switchBranch>) => { await moveHold; return switchBranch(...args); };
    } else {
      const fork = cm.fork.bind(cm);
      cm.fork = async (...args: Parameters<typeof cm.fork>) => { await moveHold; return fork(...args); };
    }
    const drains = holdDrains(framework);
    const surgery = action === 'rollback'
      ? framework.rollbackToMessage('agent', { messageId: ids[0]! })
      : framework.suppressMessages('agent', { messageIds: [ids[1]!] });
    void surgery.catch(() => {});
    try {
      await assert.rejects(framework.stop(100), (error: unknown) =>
        error instanceof ShutdownTimeoutError && error.pending.includes('surgery:' + (action === 'rollback' ? 'roll back' : 'suppress')));
    } finally { finishMove(); }
    const result = await surgery;
    assert.ok(result.messagesRemoved > 0, JSON.stringify(result));
    assert.equal(drains.started(), 0, 'no delivery started while the framework stops');
    assert.ok(logged.some((line) => line.includes('delivery after ' + action + ' agent=agent not started')), logged.join('\n'));
    await framework.stop();
    assert.equal(framework.getStore().isClosed(), true);
    assert.deepEqual(rejections, []);
  });

  it("an operation that outlasts stop()'s budget fails the stop and keeps the store open for a retry", async () => {
    const framework = await create();
    const drains = holdDrains(framework);
    const syncing = framework.syncDiscordAwarenessMarkers();
    await until(() => drains.started() > 0, 'the sync to wait on its drain');
    await assert.rejects(
      framework.stop(100),
      (error: unknown) => error instanceof ShutdownTimeoutError
        && error.pending.includes('awareness:sync')
        && /^Shutdown timed out after 100 ms; pending: awareness:sync$/.test(error.message),
    );
    assert.equal(framework.getStore().isClosed(), false, 'the operation may still write');
    assert.ok(order.includes('modules stopped'), 'timeout still proceeds with teardown');
    // Bounded: a sync admitted here would wait at a drain of its own, so it
    // fails the test rather than hanging it.
    const late = framework.syncDiscordAwarenessMarkers().then(() => 'admitted', (error: unknown) => String(error));
    const stillRunning = new Promise<string>((resolve) => { setTimeout(() => resolve('still running'), 1_000).unref(); });
    assert.equal(await Promise.race([late, stillRunning]), 'Error: awareness sync refused: the framework is stopping',
      'no stop() is waiting now, so a new sync is refused');
    await assert.rejects(framework.stop(100), (error: unknown) =>
      error instanceof ShutdownTimeoutError && error.pending.includes('awareness:sync'));
    assert.equal(framework.getStore().isClosed(), false, 'a still-running retry keeps the store open too');
    drains.release();
    await syncing;
    await framework.stop();
    assert.equal(framework.getStore().isClosed(), true);
    assert.deepEqual(rejections, []);
  });
  const lateCalls: Array<[string, (framework: AgentFramework) => unknown]> = [
    ['quiesce', (f) => f.quiesce()],
    ['resume', (f) => f.resume()],
    ['roll back', (f) => f.rollbackToMessage('agent', { messageId: 'invalid' })],
    ['suppress', (f) => f.suppressMessages('agent', { messageIds: ['invalid'] })],
    ['undo', (f) => f.undoLastTurn('agent')],
    ['redo', (f) => f.redo('agent')],
    ['maintain', (f) => f.maintenanceTick()],
    ['puppet', (f) => f.puppetToolCall('agent', 'unused', {})],
    ['switch branch', (f) => f.switchBranch('main')],
    ['connect MCPL server', (f) => f.connectMcplServer({ id: 'late', command: 'unused' })],
    ['disconnect MCPL server', (f) => f.disconnectMcplServer('late')],
    ['restart MCPL server', (f) => f.restartMcplServer('late')],
    ['awareness sync', (f) => f.syncDiscordAwarenessMarkers()],
    ['awareness cancel', (f) => f.cancelDiscordAwareness('no-such-batch')],
    ['awareness retract', (f) => f.retractDiscordAwareness('all')],
  ];
  for (const [verb, call] of lateCalls) {
    it(verb + ' is refused during teardown and after stop(), with no writes and no operator log', async () => {
      const framework = await create();
      let backendCalls = 0;
      Object.assign(internals(framework), {
        mcplHostCapabilities: {},
        mcplServerRegistry: {
          getAllServers: () => [], closeAll: async () => {},
          removeServer: async () => { backendCalls++; },
        },
        connectMcplServerInternal: async () => { backendCalls++; },
        refreshMcplTools: async () => { backendCalls++; },
        emitMcplToolDiff: () => { backendCalls++; },
      });
      let finishModules!: () => void;
      const hold = new Promise<void>((resolve) => { finishModules = resolve; });
      framework.getModule('teardown-probe')!.stop = async () => {
        order.push('modules stopped');
        await hold;
      };
      const stopping = framework.stop();
      await until(() => order.includes('modules stopped'), 'module teardown');
      const sequence = framework.getStore().currentSequence();
      const branch = framework.getStore().currentBranch().name;
      const logPath = framework.getOperatorLogPath()!;
      const log = () => existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      const beforeLog = log();
      const refused = async () => assert.rejects(
        Promise.resolve().then(() => call(framework)),
        (error: unknown) => error instanceof Error && error.message === verb + ' refused: the framework is stopping',
      );
      try {
        await refused();
        assert.equal(framework.getStore().currentSequence(), sequence);
        assert.equal(framework.getStore().currentBranch().name, branch);
        assert.equal(log(), beforeLog);
        assert.equal(backendCalls, 0);
      } finally { finishModules(); await stopping; }
      await refused();
      assert.equal(log(), beforeLog);
    });
  }

  it('a resume called once stop() has begun refuses before a held maintenance pass ends', async () => {
    const framework = await create();
    await framework.quiesce();
    let endPass!: () => void;
    internals(framework).maintenancePass = new Promise<void>((resolve) => { endPass = resolve; });
    const stopping = framework.stop();
    let settled = false;
    const resuming = framework.resume().finally(() => { settled = true; });
    void resuming.catch(() => {});
    try {
      // Refused while the maintenance pass is still held: a refusal that
      // waited for it would never settle here.
      await until(() => settled, 'the refusal, with the maintenance pass held');
      await assert.rejects(resuming, /resume refused: the framework is stopping/);
    } finally { endPass(); await stopping; await resuming.catch(() => {}); }
  });

  it('a resume checks again after its preview retries, and refuses when stop() began during them', async () => {
    const framework = await create();
    await framework.quiesce();
    let previewed = false;
    framework.previewAgentRuntimeSettings = (() => {
      previewed = true;
      return { available: false, reason: 'preview_in_flight', path: 'none', liveBudgetTokens: 0, transition: 'stable' };
    }) as typeof framework.previewAgentRuntimeSettings;
    const resuming = framework.resume();
    void resuming.catch(() => {});
    assert.equal(previewed, true);
    const stopping = framework.stop();
    await assert.rejects(resuming, /resume refused: the framework is stopping/);
    await stopping;
    assert.equal(await bootsQuiesced(), true);
  });

  it('stop() waits for a puppet tool call, so it finishes before the modules stop', { timeout: 20_000 }, async () => {
    const framework = await create();
    const fw = framework as unknown as Internals & {
      getToolsForAgent(name: string): Array<{ name: string }>;
      executeToolCall(call: unknown): Promise<ToolResult>;
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let called = false;
    fw.getToolsForAgent = () => [{ name: 'probe' }];
    fw.executeToolCall = async () => {
      called = true;
      await held;
      order.push('tool returned');
      return { success: true, data: 'done' };
    };
    // The pair's two writes are what the wait protects.
    const cm = framework.getAgent('agent')!.getContextManager();
    const addMessage = cm.addMessage.bind(cm);
    cm.addMessage = ((...args: Parameters<typeof cm.addMessage>) => {
      const id = addMessage(...args);
      order.push('message stored');
      return id;
    }) as typeof cm.addMessage;
    const puppeting = framework.puppetToolCall('agent', 'probe', {});
    void puppeting.catch(() => {});
    await until(() => called, 'the puppet call to reach its tool');
    const stopping = framework.stop();
    await releaseWhenStopWaits(release);
    const { toolUseId } = await puppeting;
    await stopping;
    assert.ok(toolUseId, 'the call has its id');
    assert.deepEqual(order, ['tool returned', 'message stored', 'message stored', 'modules stopped']);
    assert.deepEqual(rejections, []);
  });

  it("stop() waits for a branch switch from the API server, its config mount included", { timeout: 20_000 }, async () => {
    const framework = await create();
    const api = new ApiServer(framework) as unknown as {
      cmdBranchCreate(params: { name: string }): Promise<unknown>;
      cmdBranchSwitch(params: { name: string }): Promise<unknown>;
    };
    await api.cmdBranchCreate({ name: 'side' });
    const fw = internals(framework);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let mounting = false;
    const getModule = fw.moduleRegistry.getModule.bind(fw.moduleRegistry);
    fw.moduleRegistry.getModule = (name) => name === 'workspace' ? {
      materializeMount: async () => { mounting = true; await held; order.push('config materialized'); },
    } : getModule(name);
    const switching = api.cmdBranchSwitch({ name: 'side' });
    void switching.catch(() => {});
    await until(() => mounting, 'the switch to reach its config mount');
    const stopping = framework.stop();
    await releaseWhenStopWaits(release);
    await switching;
    await stopping;
    assert.deepEqual(order, ['config materialized', 'modules stopped']);
    assert.deepEqual(rejections, []);
  });

  it("the API server's current branch follows the store when a switch fails after moving it, and clients hear of the move", async () => {
    const framework = await create();
    try {
      const api = new ApiServer(framework) as unknown as {
        cmdBranchCreate(params: { name: string }): Promise<unknown>;
        cmdBranchSwitch(params: { name: string }): Promise<unknown>;
        cmdBranchCurrent(): Promise<{ name: string }>;
        broadcast(event: string, data: unknown): void;
      };
      await api.cmdBranchCreate({ name: 'side' });
      const broadcasts: Array<[string, unknown]> = [];
      api.broadcast = (event, data) => { broadcasts.push([event, data]); };
      const fw = internals(framework);
      const getModule = fw.moduleRegistry.getModule.bind(fw.moduleRegistry);
      fw.moduleRegistry.getModule = (name) => name === 'workspace' ? {
        materializeMount: async () => { throw new Error('disk full'); },
      } : getModule(name);
      await assert.rejects(api.cmdBranchSwitch({ name: 'side' }), /disk full/);
      assert.equal(framework.getStore().currentBranch().name, 'side');
      assert.equal((await api.cmdBranchCurrent()).name, 'side');
      assert.deepEqual(broadcasts, [['branch:switched', { from: 'main', to: 'side' }]]);
    } finally { await framework.stop(); }
  });

  it("a successful switch from the API server names the store's branch as where it moved from, even with a stale cache", async () => {
    const framework = await create();
    try {
      const api = new ApiServer(framework) as unknown as {
        cmdBranchCreate(params: { name: string }): Promise<unknown>;
        cmdBranchSwitch(params: { name: string }): Promise<unknown>;
        broadcast(event: string, data: unknown): void;
      };
      await api.cmdBranchCreate({ name: 'side' });
      const broadcasts: Array<[string, unknown]> = [];
      api.broadcast = (event, data) => { broadcasts.push([event, data]); };
      // As after a rollback made outside the API server.
      (api as unknown as { lastKnownBranch: string }).lastKnownBranch = 'stale';
      await api.cmdBranchSwitch({ name: 'side' });
      assert.deepEqual(broadcasts, [['branch:switched', { from: 'main', to: 'side' }]]);
    } finally { await framework.stop(); }
  });

  it('a switch from the API server that waits for running maintenance names the branch it moved to, and the current branch is the store\'s throughout', async () => {
    const framework = await create();
    try {
      const api = new ApiServer(framework) as unknown as {
        cmdBranchCreate(params: { name: string }): Promise<unknown>;
        cmdBranchSwitch(params: { name: string }): Promise<unknown>;
        cmdBranchCurrent(): Promise<{ name: string }>;
        broadcast(event: string, data: unknown): void;
      };
      await api.cmdBranchCreate({ name: 'side' });
      const broadcasts: Array<[string, unknown]> = [];
      api.broadcast = (event, data) => { broadcasts.push([event, data]); };
      // A maintenance pass still running: the switch moves the store once it ends.
      let finish!: () => void;
      internals(framework).maintenancePass = new Promise<void>((resolve) => { finish = resolve; });
      const switching = api.cmdBranchSwitch({ name: 'side' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(framework.getStore().currentBranch().name, 'main', 'the switch waits for the pass');
      assert.equal((await api.cmdBranchCurrent()).name, 'main');
      assert.deepEqual(broadcasts, []);
      finish();
      internals(framework).maintenancePass = null;
      await switching;
      assert.equal(framework.getStore().currentBranch().name, 'side');
      assert.equal((await api.cmdBranchCurrent()).name, 'side');
      assert.deepEqual(broadcasts, [['branch:switched', { from: 'main', to: 'side' }]]);
    } finally { await framework.stop(); }
  });

  it('two API switches handled together: the second is refused while the first holds the store, and only the first is announced', async () => {
    const framework = await create();
    try {
      const api = new ApiServer(framework) as unknown as {
        cmdBranchCreate(params: { name: string }): Promise<unknown>;
        cmdBranchSwitch(params: { name: string }): Promise<unknown>;
        cmdBranchCurrent(): Promise<{ name: string }>;
        broadcast(event: string, data: unknown): void;
      };
      await api.cmdBranchCreate({ name: 'a' });
      await api.cmdBranchCreate({ name: 'b' });
      const broadcasts: Array<[string, unknown]> = [];
      api.broadcast = (event, data) => { broadcasts.push([event, data]); };
      const [first, second] = await Promise.allSettled([api.cmdBranchSwitch({ name: 'a' }), api.cmdBranchSwitch({ name: 'b' })]);
      assert.equal(first.status, 'fulfilled');
      assert.ok(
        second.status === 'rejected' && second.reason instanceof OperatorActionError && second.reason.code === 'agent-busy',
        second.status === 'rejected' ? String(second.reason) : 'the second switch went through',
      );
      assert.deepEqual(broadcasts, [['branch:switched', { from: 'main', to: 'a' }]]);
      assert.equal(framework.getStore().currentBranch().name, 'a');
      assert.equal((await api.cmdBranchCurrent()).name, 'a');
    } finally { await framework.stop(); }
  });

  it("the API server's current branch is the store's while a switch is still running", { timeout: 20_000 }, async () => {
    const framework = await create();
    try {
      const api = new ApiServer(framework) as unknown as {
        cmdBranchCreate(params: { name: string }): Promise<unknown>;
        cmdBranchSwitch(params: { name: string }): Promise<unknown>;
        cmdBranchCurrent(): Promise<{ name: string }>;
        cmdBranchDelete(params: { name: string }): Promise<unknown>;
      };
      await api.cmdBranchCreate({ name: 'side' });
      const fw = internals(framework);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let mounting = false;
      const getModule = fw.moduleRegistry.getModule.bind(fw.moduleRegistry);
      fw.moduleRegistry.getModule = (name) => name === 'workspace' ? {
        materializeMount: async () => { mounting = true; await held; },
      } : getModule(name);
      const switching = api.cmdBranchSwitch({ name: 'side' });
      try {
        await until(() => mounting, 'the switch to reach its config mount');
        assert.equal((await api.cmdBranchCurrent()).name, 'side');
        await assert.rejects(api.cmdBranchDelete({ name: 'side' }), /Cannot delete current branch/);
        // The switch holds the store through its mount.
        assert.throws(() => framework.undoLastTurn('agent'), (error: unknown) => error instanceof OperatorActionError
          && error.code === 'agent-busy' && error.message === 'Cannot undo: the store is under live switch branch for every agent');
        assert.throws(() => framework.redo('agent'), (error: unknown) => error instanceof OperatorActionError
          && error.code === 'agent-busy' && error.message === 'Cannot redo: the store is under live switch branch for every agent');
        // A host/command undo in turns mode answers the refusal with its code.
        const connection = Object.assign(new EventEmitter(), { id: 'srv' });
        fw.wireMcplEvents(connection, { id: 'srv' });
        let answer: unknown;
        connection.emit('host-command', { command: 'undo', agentName: 'agent', turns: 1 }, {
          id: 11,
          respond: (result: unknown) => { answer = result; },
          respondError: (error: unknown) => { answer = { respondError: String(error) }; },
        });
        await until(() => answer !== undefined, 'the host/command undo to answer');
        assert.deepEqual(answer, {
          ok: false,
          error: 'Cannot undo: the store is under live switch branch for every agent',
          code: 'agent-busy',
        });
      } finally { release(); }
      await switching;
    } finally { await framework.stop(); }
  });

  it("switchBranch() moves the branch and starts no marks' delivery: a branch move never marks", async () => {
    const framework = await create();
    try {
      const api = new ApiServer(framework) as unknown as { cmdBranchCreate(params: { name: string }): Promise<unknown> };
      await api.cmdBranchCreate({ name: 'side' });
      const drains = holdDrains(framework);
      const marks = framework.listDiscordAwareness();
      await framework.switchBranch('side');
      assert.equal(framework.getStore().currentBranch().name, 'side');
      assert.equal(drains.started(), 0);
      assert.deepEqual(framework.listDiscordAwareness(), marks, 'the awareness ledger is unchanged');
    } finally { await framework.stop(); }
  });

  it('stop() keeps the store open until an awareness drain already running has ended', async () => {
    const framework = await create();
    const fw = framework as unknown as {
      runDiscordAwarenessDrain(serverId: string, pass: unknown): Promise<unknown>;
      drainDiscordAwarenessOutbox(serverId: string): Promise<unknown>;
      discordAwarenessDrains: Map<string, Promise<unknown>>;
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let storeOpenAtEnd: boolean | undefined;
    // A pass with a request on the wire, as drainDiscordAwarenessOutbox
    // registers it: it ends when the request is answered.
    fw.runDiscordAwarenessDrain = async () => {
      await held;
      storeOpenAtEnd = !framework.getStore().isClosed();
      return { status: 'delivered', delivered: 0, failed: 0 };
    };
    const drain = fw.drainDiscordAwarenessOutbox('srv');
    assert.equal(fw.discordAwarenessDrains.size, 1, 'the pass is registered');
    const stopping = framework.stop();
    try {
      await until(() => order.includes('modules stopped'), 'module teardown');
      // Past the teardown, only the drain stands between stop() and the
      // store's close, which would otherwise follow within a few turns.
      for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      assert.equal(framework.getStore().isClosed(), false, 'the store waits for the drain');
    } finally {
      release();
      await stopping;
      await drain;
    }
    assert.equal(storeOpenAtEnd, true, 'the drain ended with the store still open');
    assert.equal(framework.getStore().isClosed(), true);
  });

  it('an awareness sync waits for a delivery pass already under way, though nothing is left due', async () => {
    const framework = await create();
    const fw = framework as unknown as {
      runDiscordAwarenessDrain(serverId: string, pass: unknown): Promise<unknown>;
      drainDiscordAwarenessOutbox(serverId: string): Promise<unknown>;
      discordAwarenessDrains: Map<string, Promise<unknown>>;
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // A pass whose last request is on the wire: nothing is due, and it ends
    // when that request is answered.
    fw.runDiscordAwarenessDrain = async () => {
      await held;
      return { status: 'delivered', delivered: 1, failed: 0 };
    };
    const drain = fw.drainDiscordAwarenessOutbox('srv');
    assert.equal(fw.discordAwarenessDrains.size, 1, 'the pass is registered');
    const settled = new Set<string>();
    const sync = (server?: string) => framework.syncDiscordAwarenessMarkers(server).then(() => { settled.add(server ?? 'all'); });
    const syncs = [sync(), sync('srv'), sync('other')];
    // A sync with nothing to wait for settles in promise jobs alone, so a few
    // turns of the event loop are enough to see which syncs are waiting.
    const turns = async () => { for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => { setImmediate(resolve); }); };
    try {
      await turns();
      assert.deepEqual([...settled], ['other'], "only another server's sync settles while the pass is held");
    } finally {
      release();
      await drain;
      await Promise.all(syncs);
    }
    assert.deepEqual([...settled].sort(), ['all', 'other', 'srv']);
    await framework.stop();
  });

  it("a background delivery leaves another occasion's running pass to that occasion", async () => {
    const framework = await create();
    const fw = framework as unknown as {
      runDiscordAwarenessDrain(serverId: string, pass: unknown): Promise<unknown>;
      drainDiscordAwarenessOutbox(serverId: string): Promise<unknown>;
      discordAwarenessDrains: Map<string, Promise<unknown>>;
      deliverDiscordAwarenessInBackground(occasion: string, agentName: string): void;
      opsAlert(kind: string, key: string, text: string): void;
    };
    let fail!: (error: Error) => void;
    fw.runDiscordAwarenessDrain = () => new Promise((_, reject) => { fail = reject; });
    // The pass's own occasion handles its failure.
    const drain = fw.drainDiscordAwarenessOutbox('srv').catch(() => {});
    const alerts: string[] = [];
    fw.opsAlert = (kind, _key, text) => { alerts.push(`${kind}: ${text}`); };
    fw.deliverDiscordAwarenessInBackground('rollback', 'agent'); // nothing is due
    fail(new Error('the route went away'));
    await drain;
    for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => { setImmediate(resolve); });
    fw.discordAwarenessDrains.delete('srv'); // as the real pass leaves the registry
    assert.deepEqual(alerts, [], "the background delivery reported no other occasion's failure");
    await framework.stop();
  });

  it('a branch switch during a live turn is refused, and the branch stays', async () => {
    const framework = await create();
    const api = new ApiServer(framework) as unknown as {
      cmdBranchCreate(params: { name: string }): Promise<unknown>;
      cmdBranchSwitch(params: { name: string }): Promise<unknown>;
      cmdBranchCurrent(): Promise<{ name: string }>;
    };
    await api.cmdBranchCreate({ name: 'side' });
    const broadcasts: unknown[] = [];
    (api as unknown as { broadcast(event: string, data: unknown): void }).broadcast = (event, data) => { broadcasts.push([event, data]); };
    // A stale cache, as after a rollback made outside the API server.
    (api as unknown as { lastKnownBranch: string }).lastKnownBranch = 'stale';
    // A turn holds its token from dequeue, before its stream registers.
    const tokens = internals(framework).activeTurnTokens;
    tokens.set('agent', -1);
    try {
      await assert.rejects(framework.switchBranch('side'), /^OperatorActionError: Cannot switch branch while agent is idle\+turn-alive/);
      await assert.rejects(api.cmdBranchSwitch({ name: 'side' }), /Cannot switch branch while agent is idle\+turn-alive/);
      assert.equal(framework.getStore().currentBranch().name, 'main');
      assert.equal((await api.cmdBranchCurrent()).name, 'main');
      assert.deepEqual(broadcasts, [], 'a refused switch moved nothing, so it announces nothing');
    } finally { tokens.delete('agent'); }
    await framework.stop();
  });

  it('a branch switch from the API server once stop() has begun is refused, and the branch stays', async () => {
    const framework = await create();
    const api = new ApiServer(framework) as unknown as {
      cmdBranchCreate(params: { name: string }): Promise<unknown>;
      cmdBranchSwitch(params: { name: string }): Promise<unknown>;
      cmdBranchCurrent(): Promise<{ name: string }>;
    };
    await api.cmdBranchCreate({ name: 'side' });
    let finishModules!: () => void;
    const hold = new Promise<void>((resolve) => { finishModules = resolve; });
    framework.getModule('teardown-probe')!.stop = async () => {
      order.push('modules stopped');
      await hold;
    };
    const stopping = framework.stop();
    try {
      await until(() => order.includes('modules stopped'), 'module teardown');
      await assert.rejects(api.cmdBranchSwitch({ name: 'side' }), /^Error: switch branch refused: the framework is stopping$/);
      assert.equal(framework.getStore().currentBranch().name, 'main');
      assert.equal((await api.cmdBranchCurrent()).name, 'main');
    } finally { finishModules(); await stopping; }
    // With the store closed too, the refusal is what the caller sees.
    await assert.rejects(api.cmdBranchSwitch({ name: 'side' }), /^Error: switch branch refused: the framework is stopping$/);
    assert.equal((await api.cmdBranchCurrent()).name, 'main');
  });

  for (const action of ['connect', 'disconnect', 'restart'] as const) {
    it('stop() waits for an MCPL ' + action + ' already running before it closes the connections', async () => {
      const framework = await create();
      const fw = framework as unknown as Internals & {
        mcplHostCapabilities: object;
        mcplServerConfigs: Map<string, { id: string; command: string }>;
        connectMcplServerInternal(config: unknown): Promise<void>;
        refreshMcplTools(): Promise<void>;
        emitMcplToolDiff(...args: unknown[]): void;
      };
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let entered = false;
      let connected = action !== 'connect';
      fw.mcplHostCapabilities = {};
      fw.mcplServerConfigs.set('srv', { id: 'srv', command: 'unused' });
      fw.connectMcplServerInternal = async () => {
        entered = true;
        await held;
        connected = true;
        order.push('connection opened');
      };
      fw.refreshMcplTools = async () => {};
      fw.emitMcplToolDiff = () => {};
      fw.mcplServerRegistry = {
        getAllServers: () => [],
        // A connect asks whether the server is connected already, as the
        // registry answers for an unknown server.
        getServer: () => null,
        removeServer: async () => {
          entered = true;
          await held;
          connected = false;
          order.push('connection removed');
        },
        closeAll: async () => { connected = false; order.push('connections closed'); },
      };
      const running = action === 'connect' ? framework.connectMcplServer({ id: 'srv', command: 'unused' })
        : action === 'disconnect' ? framework.disconnectMcplServer('srv') : framework.restartMcplServer('srv');
      void running.catch(() => {});
      await until(() => entered, 'MCPL operation');
      const stopping = framework.stop();
      await releaseWhenStopWaits(release);
      // A disconnect finishes. A connect, or a restart's connect, that stop()
      // overtook says so rather than reporting a connection the teardown is
      // about to close.
      if (action === 'disconnect') await running;
      else {
        await assert.rejects(running, action === 'connect'
          ? /^Error: MCP server "srv" was not connected: the framework stopped while it was connecting$/
          : /^Error: MCP server "srv" is down: it was disconnected for its restart, and the restart's connect failed: MCP server "srv" was not connected: the framework stopped while it was connecting$/);
      }
      await stopping;
      assert.equal(connected, false);
      const settled = action === 'disconnect' ? 'connection removed' : 'connection opened';
      assert.ok(order.includes(settled) && order.indexOf(settled) < order.indexOf('modules stopped'), order.join(', '));
    });
  }

  for (const action of ['undo', 'redo', 'rollback', 'suppress'] as const) {
    it(action + "'s config materialization doesn't hold its caller, and stop() waits for it", { timeout: 20_000 }, async () => {
      const framework = await create();
      const fw = internals(framework);
      const cm = framework.getAgent('agent')!.getContextManager();
      const sequenceBefore = framework.getStore().currentSequence();
      const ids = [1, 2, 3].map((n) => cm.addMessage('user', [{ type: 'text', text: 'm' + n }]));
      fw.saveTurnCheckpoints('agent', [{ agentName: 'agent', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
      if (action === 'redo') framework.undoLastTurn('agent');
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let materializing = false;
      const getModule = fw.moduleRegistry.getModule.bind(fw.moduleRegistry);
      fw.moduleRegistry.getModule = (name) => name === 'workspace' ? {
        materializeMount: async () => { materializing = true; await held; order.push('config materialized'); },
      } : getModule(name);
      if (action === 'undo') framework.undoLastTurn('agent');
      else if (action === 'redo') framework.redo('agent');
      else if (action === 'rollback') await framework.rollbackToMessage('agent', { messageId: ids[0]! });
      else await framework.suppressMessages('agent', { messageIds: [ids[1]!] });
      assert.equal(materializing, true, 'the caller returned before file IO settled');
      const stopping = framework.stop();
      await releaseWhenStopWaits(release);
      await stopping;
      assert.deepEqual(order, ['config materialized', 'modules stopped']);
    });
  }

  it('a config materialization that fails is logged, and its undo still succeeds', async () => {
    const framework = await create();
    const fw = internals(framework);
    const cm = framework.getAgent('agent')!.getContextManager();
    const sequenceBefore = framework.getStore().currentSequence();
    cm.addMessage('user', [{ type: 'text', text: 'a turn' }]);
    fw.saveTurnCheckpoints('agent', [{ agentName: 'agent', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
    const getModule = fw.moduleRegistry.getModule.bind(fw.moduleRegistry);
    fw.moduleRegistry.getModule = (name) => name === 'workspace' ? {
      materializeMount: async () => { throw new Error('disk full'); },
    } : getModule(name);
    assert.equal(framework.undoLastTurn('agent').undone, true);
    await framework.stop();
    assert.ok(logged.some((line) => line.includes('re-materializing the config mount after a branch switch failed') && line.includes('disk full')), logged.join('\n'));
    assert.deepEqual(rejections, []);
  });

  for (const action of ['rollback', 'suppress'] as const) it('stop() also waits for the materialization a ' + action + ' in flight starts after stop() first reads the set', { timeout: 20_000 }, async () => {
    const framework = await create();
    const fw = internals(framework);
    const cm = framework.getAgent('agent')!.getContextManager();
    const ids = [1, 2, 3].map((n) => cm.addMessage('user', [{ type: 'text', text: 'm' + n }]));
    let finishSwitch!: () => void;
    const switchHold = new Promise<void>((resolve) => { finishSwitch = resolve; });
    if (action === 'rollback') {
      const switchBranch = cm.switchBranch.bind(cm);
      cm.switchBranch = async (...args: Parameters<typeof cm.switchBranch>) => { await switchHold; return switchBranch(...args); };
    } else {
      const fork = cm.fork.bind(cm);
      cm.fork = async (...args: Parameters<typeof cm.fork>) => { await switchHold; return fork(...args); };
    }
    let finishMaterialize!: () => void;
    const materializeHold = new Promise<void>((resolve) => { finishMaterialize = resolve; });
    let materializing = false;
    const getModule = fw.moduleRegistry.getModule.bind(fw.moduleRegistry);
    fw.moduleRegistry.getModule = (name) => name === 'workspace' ? {
      materializeMount: async () => { materializing = true; await materializeHold; order.push('config materialized'); },
    } : getModule(name);
    const rolling = action === 'rollback'
      ? framework.rollbackToMessage('agent', { messageId: ids[0]! })
      : framework.suppressMessages('agent', { messageIds: [ids[1]!] });
    void rolling.catch(() => {});
    const stopping = framework.stop();
    await releaseWhenStopWaits(finishSwitch);
    try {
      await rolling;
      assert.equal(materializing, true);
      await until(() => waitReads >= 2 || order.includes('modules stopped'), 'stop to discover child work', 30_000);
      assert.equal(order.includes('modules stopped'), false, 'the original snapshot is not the whole wait');
    } finally { finishMaterialize(); await stopping; }
    assert.deepEqual(order, ['config materialized', 'modules stopped']);
  });

  it("a trace listener that calls stop() doesn't lose the operation whose trace it heard", async () => {
    const framework = await create();
    const fw = internals(framework);
    const cm = framework.getAgent('agent')!.getContextManager();
    const sequenceBefore = framework.getStore().currentSequence();
    cm.addMessage('user', [{ type: 'text', text: 'a turn' }]);
    fw.saveTurnCheckpoints('agent', [{ agentName: 'agent', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
    // Hold the undo's preview, the last thing it does before it answers.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let previewing = false;
    (fw as unknown as { lastVisiblePreview(name: string): Promise<unknown> }).lastVisiblePreview = async () => {
      previewing = true;
      await held;
      return null;
    };
    let stopping: Promise<void> | undefined;
    framework.onTrace((event) => {
      if (event.type === 'undo:completed') stopping = framework.stop();
    });
    const connection = Object.assign(new EventEmitter(), { id: 'srv' });
    fw.wireMcplEvents(connection, { id: 'srv' });
    connection.emit('host-command', { command: 'undo', agentName: 'agent', turns: 1 }, {
      id: 9,
      respond: () => { order.push('undo answered'); },
      respondError: () => { order.push('undo failed'); },
    });
    await until(() => stopping !== undefined && (previewing || order.includes('undo failed')), 'reentrant stop and the undo\'s preview');
    await releaseWhenStopWaits(release);
    await stopping;
    await until(() => order.includes('undo answered') || order.includes('undo failed'), 'undo answer');
    assert.ok(order.indexOf('undo answered') >= 0 && order.indexOf('undo answered') < order.indexOf('modules stopped'), order.join(', '));
    assert.deepEqual(rejections, []);
  });

  it("the API server's undo whose trace starts stop() answers, and starts no marks' delivery", async () => {
    const framework = await create();
    const fw = internals(framework);
    const cm = framework.getAgent('agent')!.getContextManager();
    const record = (fw as unknown as { recordTurnCheckpoint(name: string): void }).recordTurnCheckpoint.bind(fw);
    record('agent');
    cm.addMessage('user', [{ type: 'text', text: 'a turn' }]);
    const drains = holdDrains(framework);
    let stopping: Promise<void> | undefined;
    framework.onTrace((event) => {
      if (event.type === 'undo:completed' && !stopping) stopping = framework.stop();
    });
    const api = new ApiServer(framework) as unknown as {
      cmdUndo(params: { agentName: string }): Promise<{ undone: boolean }>;
      broadcast(event: string, data: unknown): void;
    };
    api.broadcast = () => {};
    assert.equal((await api.cmdUndo({ agentName: 'agent' })).undone, true);
    assert.ok(stopping, "the undo's trace started stop()");
    await stopping;
    assert.equal(drains.started(), 0, 'a branch move starts no delivery');
    assert.deepEqual(rejections, []);
  });

  it('a multi-turn host/command undo whose first turn starts stop() still undoes every turn it was asked for', async () => {
    const framework = await create();
    const fw = internals(framework);
    const cm = framework.getAgent('agent')!.getContextManager();
    // Two turns, each checkpointed as a real turn's start records it.
    const record = (fw as unknown as { recordTurnCheckpoint(name: string): void }).recordTurnCheckpoint.bind(fw);
    record('agent');
    cm.addMessage('user', [{ type: 'text', text: 'turn one' }]);
    record('agent');
    cm.addMessage('user', [{ type: 'text', text: 'turn two' }]);
    let stopping: Promise<void> | undefined;
    framework.onTrace((event) => {
      if (event.type === 'undo:completed' && !stopping) stopping = framework.stop();
    });
    const connection = Object.assign(new EventEmitter(), { id: 'srv' });
    fw.wireMcplEvents(connection, { id: 'srv' });
    let answer: { ok?: boolean; undone?: number; requested?: number } | undefined;
    // Read as the answer goes out: stop() closes the store once the undo is done.
    let checkpoints: unknown[] | undefined;
    let texts: string[] = [];
    connection.emit('host-command', { command: 'undo', agentName: 'agent', turns: 2 }, {
      id: 10,
      respond: (result: typeof answer) => {
        answer = result;
        checkpoints = fw.getTurnCheckpoints('agent');
        texts = cm.getAllMessages().map((m) => JSON.stringify(m.content));
      },
      respondError: () => { order.push('undo failed'); },
    });
    await until(() => answer !== undefined || order.includes('undo failed'), 'the undo to answer');
    assert.equal(answer?.ok, true, JSON.stringify(answer));
    assert.equal(answer?.undone, 2, JSON.stringify(answer));
    assert.deepEqual(checkpoints, [], 'both turns were rolled back');
    assert.ok(!texts.some((t) => t.includes('turn one') || t.includes('turn two')), texts.join(' | '));
    assert.ok(stopping, 'the first turn started stop()');
    await stopping;
    assert.deepEqual(rejections, []);
  });

  for (const elapsed of [6_000, 9_999, 11_000]) it("work an operation starts shares stop()'s deadline, " + elapsed + ' ms in', async () => {
    const framework = await create();
    const fw = internals(framework);
    const cm = framework.getAgent('agent')!.getContextManager();
    const ids = [1, 2, 3].map((n) => cm.addMessage('user', [{ type: 'text', text: 'm' + n }]));
    let finishSwitch!: () => void;
    const switchHold = new Promise<void>((resolve) => { finishSwitch = resolve; });
    const switchBranch = cm.switchBranch.bind(cm);
    cm.switchBranch = async (...args: Parameters<typeof cm.switchBranch>) => { await switchHold; return switchBranch(...args); };
    let finishMaterialize!: () => void;
    const materializeHold = new Promise<void>((resolve) => { finishMaterialize = resolve; });
    const getModule = fw.moduleRegistry.getModule.bind(fw.moduleRegistry);
    fw.moduleRegistry.getModule = (name) => name === 'workspace' ? {
      materializeMount: async () => { await materializeHold; order.push('config materialized'); },
    } : getModule(name);
    const rolling = framework.rollbackToMessage('agent', { messageId: ids[0]! });
    void rolling.catch(() => {});
    const nowProperty = Object.getOwnPropertyDescriptor(performance, 'now');
    const timer = globalThis.setTimeout;
    const budgets: number[] = [];
    let now = 0;
    let stopping: Promise<void> | undefined;
    try {
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
      globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        if (args[1] !== undefined && args[1] > 100) budgets.push(args[1]);
        return timer(...args);
      }) as typeof setTimeout;
      stopping = framework.stop(10_000);
      void stopping.catch(() => {});
      await releaseWhenStopWaits(() => { now = elapsed; finishSwitch(); });
      await rolling;
      await until(() => waitReads >= 2 || order.includes('modules stopped'), 'the second operator wait');
      // Clock input controls the remaining budget. In the timeout cases,
      // work stays held until the assertion, so elapsed wall time is no verdict.
      if (elapsed === 6_000) {
        assert.deepEqual(budgets.slice(0, 2), [10_000, 4_000]);
        finishMaterialize();
        await stopping;
      }
      else {
        await assert.rejects(stopping, (error: unknown) =>
          error instanceof ShutdownTimeoutError && error.pending.includes('config:materialize')
            && error.message.startsWith('Shutdown timed out after 10000 ms;'));
        assert.equal(framework.getStore().isClosed(), false);
      }
    } finally {
      finishSwitch();
      finishMaterialize();
      globalThis.setTimeout = timer;
      if (nowProperty) Object.defineProperty(performance, 'now', nowProperty);
      else Reflect.deleteProperty(performance, 'now');
      await rolling.catch(() => {});
      await stopping?.catch(() => {});
      await framework.stop();
    }
  });

});
