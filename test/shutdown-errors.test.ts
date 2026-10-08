import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, renameSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, ShutdownTimeoutError, DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type Module, type ModuleContext } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { McplTransport } from '../src/mcpl/transport.js';
import { McplServerRegistry } from '../src/mcpl/server-registry.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';

function module(name: string, stop: () => Promise<void>): Module {
  return { name, async start() {}, stop, async onProcess() { return {}; }, getTools: () => [],
    async handleToolCall() { throw new Error('No tool calls expected'); } };
}

async function fixture(t: import('node:test').TestContext, modules: Module[] = [], withAgent = false) {
  const dir = mkdtempSync(join(tmpdir(), 'framework-stop-'));
  const config = { storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: withAgent ? [{ name: 'assistant', model: 'test', systemPrompt: 'system' }] : [],
    modules, syncIntervalMs: 0, maintenanceIntervalMs: 0 };
  const framework = await AgentFramework.create(config);
  const store = framework.getStore();
  const close = store.close.bind(store);
  t.after(() => { try { close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  return { framework, store, config };
}

test('successful stop persists Chronicle state for a new framework', async t => {
  const { framework, store, config } = await fixture(t);
  store.registerState({ id: 'shutdown-test', strategy: 'snapshot' });
  const expected = { work: 'completed', count: 7 };
  store.setStateJson('shutdown-test', expected);
  await framework.stop();
  const reopened = await AgentFramework.create(config);
  try { assert.deepEqual(reopened.getStore().getStateJson('shutdown-test'), expected); }
  finally { await reopened.stop(); }
});

// The author's host reproduction allows a finite six-second module stop.
// Chronicle state written before and during teardown must survive reopen.
test('bare stop waits for a slow finite module and persists its final state', async t => {
  const completed = deferred();
  let context!: ModuleContext;
  const slow = module('slow', async () => {
    await new Promise<void>(done => setTimeout(done, 6000));
    try { context.setState({ completed: true }); } finally { completed.resolve(); }
  });
  slow.start = async ctx => { context = ctx; };
  const { framework, store, config } = await fixture(t, [slow]);
  store.registerState({ id: 'before-stop', strategy: 'snapshot' });
  store.setStateJson('before-stop', { written: true });
  try { await framework.stop(); }
  finally {
    // A failing baseline must not leave the delayed module writing to a
    // store removed by the fixture's cleanup.
    await completed.promise;
  }
  const reopened = await AgentFramework.create({ ...config, modules: [] });
  try {
    assert.deepEqual(reopened.getStore().getStateJson('before-stop'), { written: true });
    assert.deepEqual(reopened.getStore().getStateJson('modules/slow/state'),
      { completed: true, externalIdMap: {} });
  } finally { await reopened.stop(); }
});

// Fleet owns its child deadline and permits cleanup beyond five seconds.
// The framework must not impose a shorter deadline on that owner.
test('bare parent stop waits for a nested child shutdown beyond five seconds', async t => {
  const completed = deferred();
  const child = await fixture(t, [module('child-slow', async () => {
    await new Promise<void>(done => setTimeout(done, 6000));
    completed.resolve();
  })]);
  let childStopped = false;
  const parent = await fixture(t, [module('fleet', async () => {
    await child.framework.stop();
    await new Promise<void>(done => setTimeout(done, 50));
    childStopped = true;
  })]);
  try {
    await parent.framework.stop();
    assert.equal(childStopped, true);
    assert.equal(parent.store.isClosed(), true);
    assert.equal(child.store.isClosed(), true);
  } finally {
    await completed.promise;
  }
});

test('borrowed-store lifecycle changes invalidate a successful stop memo', async t => {
  const { store, config } = await fixture(t);
  const framework = await AgentFramework.create({ ...config, store });
  await framework.stop();
  let calls = 0;
  await framework.addModule(module('later', async () => { calls++; }));
  await framework.stop();
  assert.equal(calls, 1);
  framework.start();
  await framework.stop();
  assert.equal((framework as any).running, false);
});

test('real Chronicle consumed close failure remains terminal with its original error', async t => {
  const { framework, store, config } = await fixture(t);
  const close = store.close.bind(store);
  let closeCalls = 0, closeFailure: unknown;
  store.close = () => {
    closeCalls++;
    // Fault only close's internal sync, after the framework's final sync.
    renameSync(config.storePath, `${config.storePath}.moved`);
    try { close(); } catch (error) { closeFailure = error; throw error; }
  };
  const stopped = framework.stop();
  await assert.rejects(stopped);
  assert.equal(store.isClosed(), true, 'Chronicle consumes its native handle before sync');
  await assert.rejects(framework.stop(), error => error === closeFailure);
  assert.equal(closeCalls, 1);
  assert.throws(() => framework.start(), /owned store is closed/);
  await assert.rejects(framework.addModule(module('later', async () => {})), /owned store is closed/);
});

test('final sync failure rejects stop and still closes an owned store', async t => {
  const { framework, store } = await fixture(t);
  const error = new Error('injected final sync failure');
  let closeCalls = 0;
  const close = store.close.bind(store);
  store.sync = () => { throw error; };
  store.close = () => { closeCalls++; close(); };
  await assert.rejects(framework.stop(), failure => failure === error);
  assert.equal(closeCalls, 1);
});

test('module stop failure waits for peers and preserves storage for retry', async t => {
  const failure = new Error('injected module failure');
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const { framework, store } = await fixture(t, [
    module('failing', async () => { order.push('failed'); throw failure; }),
    module('delayed', async () => { await waiting; order.push('delayed-stopped'); }),
  ]);
  const sync = store.sync.bind(store), close = store.close.bind(store);
  store.sync = () => { order.push('sync'); sync(); };
  store.close = () => { order.push('close'); close(); };
  let settled = false;
  // Observe rejection immediately so the baseline has no unhandled rejection.
  const stopped = framework.stop().then(() => ({ error: undefined }), error => ({ error }))
    .finally(() => { settled = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'stop must await every module even after a rejection');
    assert.deepEqual(order, ['failed']);
  } finally { release(); }
  assert.equal((await stopped).error, failure);
  assert.deepEqual(order, ['failed', 'delayed-stopped', 'sync']);
});

test('sync and close failures are both retained', async t => {
  const { framework, store } = await fixture(t);
  const syncError = new Error('injected sync failure'), closeError = new Error('injected close failure');
  store.sync = () => { throw syncError; };
  store.close = () => { throw closeError; };
  await assert.rejects(framework.stop(), error => error instanceof AggregateError &&
    error.errors.includes(syncError) && error.errors.includes(closeError));
});

test('module synchronous throw does not prevent stopping other modules', async t => {
  const failure = new Error('injected synchronous module failure');
  let otherStopped = false, syncCalls = 0;
  const { framework, store } = await fixture(t, [
    module('failing', () => { throw failure; }),
    module('other', async () => { otherStopped = true; }),
  ]);
  const sync = store.sync.bind(store);
  store.sync = () => { syncCalls++; sync(); };
  await assert.rejects(framework.stop(), error => error === failure);
  assert.equal(otherStopped, true);
  assert.equal(syncCalls, 1);
});

test('failed final storage repair rejects stop after sync and owned close', async t => {
  const { framework, store } = await fixture(t, [], true);
  const failure = new Error('injected final storage repair failure');
  framework.getAgent('assistant')!.toolResultGuard.flushUnrecorded = () => { throw failure; };
  let syncCalls = 0, closeCalls = 0;
  const sync = store.sync.bind(store), close = store.close.bind(store);
  store.sync = () => { syncCalls++; sync(); };
  store.close = () => { closeCalls++; close(); };
  await assert.rejects(framework.stop(), error => error === failure);
  assert.equal(syncCalls, 1);
  assert.equal(closeCalls, 1);
});

test('failed stop synchronizes a borrowed store without closing it', async t => {
  const { store, config } = await fixture(t);
  const borrowed = await AgentFramework.create({ ...config, store });
  const failure = new Error('injected borrowed store sync failure');
  let closeCalls = 0;
  const close = store.close.bind(store), sync = store.sync.bind(store);
  store.close = () => { closeCalls++; close(); };
  store.sync = () => { throw failure; };
  try {
    await assert.rejects(borrowed.stop(), error => error === failure);
    assert.equal(closeCalls, 0, 'the caller owns the supplied store');
  } finally { store.sync = sync; }
  store.registerState({ id: 'still-open', strategy: 'snapshot' });
  store.setStateJson('still-open', { open: true });
  assert.deepEqual(store.getStateJson('still-open'), { open: true });
});

for (const synchronous of [false, true]) {
  test(`MCPL close failure waits for other connections (synchronous=${synchronous})`, async t => {
    const failure = new Error('injected MCPL close failure');
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const registry = new McplServerRegistry();
    const servers = (registry as unknown as { servers: Map<string, McplServerConnection> }).servers;
    servers.set('failing', { close: () => synchronous ? (() => { throw failure; })() : Promise.reject(failure) } as unknown as McplServerConnection);
    servers.set('delayed', { close: async () => { await waiting; order.push('connection-closed'); } } as unknown as McplServerConnection);
    const { framework, store } = await fixture(t);
    (framework as unknown as { mcplServerRegistry: McplServerRegistry }).mcplServerRegistry = registry;
    const sync = store.sync.bind(store), close = store.close.bind(store);
    store.sync = () => { order.push('sync'); sync(); };
    store.close = () => { order.push('close'); close(); };
    let settled = false;
    const stopped = framework.stop().then(() => ({ error: undefined }), error => ({ error }))
      .finally(() => { settled = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'stop must await every MCPL connection even after a rejection');
      assert.deepEqual(order, []);
    } finally { release(); }
    assert.equal((await stopped).error, failure);
    assert.deepEqual(order, ['connection-closed', 'sync']);
    assert.equal(registry.getAllServers().length, 1);
    assert.equal(registry.getServer('failing') !== null, true);
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// The original workspace/discord stop contract writes through its saved
// ModuleContext before asynchronous resource cleanup. Keep that context usable.
test('timeout retains original contexts and pending cleanup; retry only repeats failures', async t => {
  const waiting = deferred();
  const failure = new Error('original cleanup failure');
  let failedCalls = 0, pendingCalls = 0, successfulCalls = 0;
  let failedContext!: ModuleContext, pendingContext!: ModuleContext;
  const failing = module('retryable', async () => {
    failedCalls++;
    failedContext.setState({ attempts: failedCalls });
    if (failedCalls === 1) throw failure;
  });
  failing.start = async ctx => { failedContext = ctx; ctx.registerSpeechHandler('*'); };
  const pending = module('pending', async () => {
    pendingCalls++;
    await waiting.promise;
    pendingContext.setState({ late: true });
  });
  pending.start = async ctx => { pendingContext = ctx; };
  const successful = module('successful', async () => { successfulCalls++; });
  const { framework, store, config } = await fixture(t, [failing, pending, successful]);
  let syncCalls = 0, closeCalls = 0;
  const sync = store.sync.bind(store), close = store.close.bind(store);
  store.sync = () => { syncCalls++; sync(); };
  store.close = () => { closeCalls++; close(); };
  const registry = (framework as unknown as { moduleRegistry: import('../src/module-registry.js').ModuleRegistry }).moduleRegistry;
  await assert.rejects(framework.stop(20), error => error instanceof ShutdownTimeoutError &&
    error.pending.includes('module:pending') && error.errors.includes(failure));
  assert.equal(framework.getModule('retryable'), failing);
  assert.equal(framework.getModule('pending'), pending);
  assert.equal(framework.getModule('successful'), null);
  assert.equal((registry as unknown as { speechHandlers: unknown[] }).speechHandlers.length, 1);
  assert.equal(syncCalls, 1); assert.equal(closeCalls, 0);
  assert.deepEqual(failedContext.getState(), { attempts: 1, externalIdMap: {} });
  // Concurrent retries share one real attempt, including the still running peer.
  const retry = framework.stop(1000);
  assert.equal(framework.stop(1000), retry);
  await new Promise<void>(done => setImmediate(done));
  assert.equal(failedCalls, 2); assert.equal(pendingCalls, 1); assert.equal(successfulCalls, 1);
  waiting.resolve();
  await retry;
  assert.equal(syncCalls, 2); assert.equal(closeCalls, 1);
  assert.equal((registry as unknown as { speechHandlers: unknown[] }).speechHandlers.length, 0);
  assert.equal(framework.getModule('retryable'), null);
  await framework.stop();
  assert.equal(closeCalls, 1);
  const reopened = await AgentFramework.create({ ...config, modules: [] });
  try {
    assert.deepEqual(reopened.getStore().getStateJson('modules/pending/state'), { late: true, externalIdMap: {} });
    assert.deepEqual(reopened.getStore().getStateJson('modules/retryable/state'), { attempts: 2, externalIdMap: {} });
  } finally { await reopened.stop(); }
});

test('hang-only cleanup is bounded and later rejection remains observed', async t => {
  let reject!: (error: Error) => void;
  let calls = 0;
  const hung = new Promise<void>((_, fail) => { reject = fail; });
  const { framework, store } = await fixture(t, [module('hung', () => { calls++; return hung; })]);
  await assert.rejects(framework.stop(15), error => error instanceof ShutdownTimeoutError &&
    error.pending.join(',') === 'module:hung');
  store.registerState({ id: 'after-timeout', strategy: 'snapshot' });
  store.setStateJson('after-timeout', { open: true });
  assert.equal(calls, 1);
  reject(new Error('late rejection'));
  await new Promise<void>(done => setImmediate(done));
});

test('incomplete teardown attempts final tool-result repair and sync without closing storage', async t => {
  const failure = new Error('module incomplete');
  const { framework, store } = await fixture(t, [module('failed', async () => { throw failure; })], true);
  let repairCalls = 0, syncCalls = 0;
  framework.getAgent('assistant')!.toolResultGuard.flushUnrecorded = () => { repairCalls++; };
  const sync = store.sync.bind(store);
  store.sync = () => { syncCalls++; sync(); };
  store.close = () => { assert.fail('no close before teardown'); };
  await assert.rejects(framework.stop(), error => error === failure);
  assert.equal(repairCalls, 1);
  assert.equal(syncCalls, 1);
});

test('explicit timeout syncs available state before host exit and leaves cleanup owned', async t => {
  const waiting = deferred();
  let context!: ModuleContext, calls = 0;
  const pending = module('pending', async () => {
    calls++;
    context.setState({ beforeTimeout: true });
    await waiting.promise;
  });
  pending.start = async ctx => { context = ctx; };
  const { framework, store, config } = await fixture(t, [pending]);
  try {
    await assert.rejects(framework.stop(15), ShutdownTimeoutError);
    assert.equal(store.isClosed(), false);
    // Chronicle locks the live store. A separate disk copy verifies persisted
    // bytes without closing the pending cleanup owner's handle to sync them.
    const snapshotPath = `${config.storePath}.snapshot`;
    cpSync(config.storePath, snapshotPath, { recursive: true });
    const observer = await AgentFramework.create({ ...config, storePath: snapshotPath, modules: [] });
    try {
      assert.deepEqual(observer.getStore().getStateJson('modules/pending/state'),
        { beforeTimeout: true, externalIdMap: {} });
    } finally { await observer.stop(); }
    const retry = framework.stop();
    waiting.resolve();
    await retry;
    assert.equal(calls, 1, 'a caller timeout does not restart the registry cleanup');
  } finally { waiting.resolve(); }
});

test('failed teardown retains repair and sync failures without closing pending storage', async t => {
  const teardownFailure = new Error('teardown failed');
  const repairFailure = new Error('repair failed');
  const syncFailure = new Error('sync failed');
  const { framework, store } = await fixture(t, [
    module('failed', async () => { throw teardownFailure; }),
  ], true);
  framework.getAgent('assistant')!.toolResultGuard.flushUnrecorded = () => { throw repairFailure; };
  store.sync = () => { throw syncFailure; };
  store.close = () => { assert.fail('pending cleanup retains the store'); };
  await assert.rejects(framework.stop(), error => error instanceof AggregateError &&
    error.errors.includes(teardownFailure) && error.errors.includes(repairFailure) &&
    error.errors.includes(syncFailure));
  assert.equal(store.isClosed(), false);
});

test('host-facing diagnostics include both registry labels and observed failures', async t => {
  assert.equal(DEFAULT_SHUTDOWN_TIMEOUT_MS, undefined);
  const waiting = deferred();
  const failure = new Error('observed module failure');
  const { framework } = await fixture(t, [
    module('failed', async () => { throw failure; }),
    module('pending', async () => { await waiting.promise; }),
  ]);
  const registry = new McplServerRegistry();
  (registry as any).servers.set('pending-server', { close: async () => { await waiting.promise; } });
  (framework as any).mcplServerRegistry = registry;
  try {
    await assert.rejects(framework.stop(15), error => {
      assert.ok(error instanceof AggregateError);
      const message = String(error);
      assert.match(message, /module:pending/);
      assert.match(message, /mcpl:pending-server/);
      assert.match(message, /observed module failure/);
      return true;
    });
  } finally { waiting.resolve(); }
});

test('invalid shutdown budgets fail before effects', async t => {
  let calls = 0;
  const { framework } = await fixture(t, [module('valid', async () => { calls++; })]);
  for (const budget of [0, -1, 0.5, NaN, Infinity, 2147483648]) {
    await assert.rejects(framework.stop(budget), RangeError);
  }
  assert.equal(calls, 0);
  await framework.stop();
});

test('failed final sync remains rejected after successful owned close', async t => {
  const { framework, store } = await fixture(t);
  const failure = new Error('terminal sync failure');
  let calls = 0;
  store.sync = () => { calls++; throw failure; };
  const stopped = framework.stop();
  await assert.rejects(stopped, error => error === failure);
  assert.equal(framework.stop(), stopped);
  await assert.rejects(framework.stop(), error => error === failure);
  assert.equal(calls, 1);
});

class ControlledTransport extends McplTransport {
  readonly kind = 'stdio' as const;
  calls = 0;
  constructor(private cleanup: () => Promise<void>) { super(); }
  writeLine() {}
  async close(): Promise<void> { this.calls++; await this.cleanup(); }
}

test('actual MCPL connection retries failed transport close and deduplicates pending work', async () => {
  const failure = new Error('transport cleanup failed');
  const waiting = deferred();
  let attempts = 0, events = 0;
  const transport = new ControlledTransport(async () => {
    if (++attempts === 1) throw failure;
    await waiting.promise;
  });
  const connection = Reflect.construct(McplServerConnection, ['test', null, transport]) as McplServerConnection;
  connection.on('close', () => { events++; });
  await assert.rejects(connection.close(), error => error === failure);
  assert.equal(connection.isConnected, false);
  assert.equal(connection.willReconnect, false);
  const first = connection.close(), second = connection.close();
  await new Promise<void>(done => setImmediate(done));
  assert.equal(transport.calls, 2); assert.equal(events, 0);
  waiting.resolve(); await Promise.all([first, second]);
  await connection.close();
  assert.equal(transport.calls, 2); assert.equal(events, 1);
});

test('MCPL registry retains failed and pending servers and bounds concurrent attempts', async () => {
  const registry = new McplServerRegistry();
  const servers = (registry as unknown as { servers: Map<string, McplServerConnection> }).servers;
  const waiting = deferred();
  const failure = new Error('server cleanup failed');
  let failingCalls = 0, pendingCalls = 0;
  const failing = { close: async () => { if (++failingCalls === 1) throw failure; } } as unknown as McplServerConnection;
  const pending = { close: async () => { pendingCalls++; await waiting.promise; } } as unknown as McplServerConnection;
  servers.set('failed', failing); servers.set('pending', pending);
  await assert.rejects(registry.closeAll(15), error => error instanceof ShutdownTimeoutError &&
    error.pending.includes('mcpl:pending') && error.errors.includes(failure));
  assert.equal(registry.getServer('failed'), failing); assert.equal(registry.getServer('pending'), pending);
  const first = registry.closeAll(1000), second = registry.closeAll(1000);
  await new Promise<void>(done => setImmediate(done));
  assert.equal(failingCalls, 2); assert.equal(pendingCalls, 1);
  waiting.resolve(); await Promise.all([first, second]);
  assert.equal(registry.getAllServers().length, 0);
});


test('public MCPL recovery serializes overlapping reconnects and close waits for late cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0.5);
  const waiting = deferred();
  const transport = new ControlledTransport(async () => {});
  let handshakes = 0, reconnectEvents = 0;
  t.mock.method(McplServerConnection as any, 'handshake', async () => {
    if (++handshakes === 1) throw new Error('initial connect failure');
    await waiting.promise;
    return { transport, capabilities: null, droppedCapabilities: new Set(), mcpToolsAdvertised: false };
  });
  const connection = await McplServerConnection.connectWithReconnect(
    { id: 'overlap', command: 'unused', reconnect: true, reconnectIntervalMs: 10 }, { version: '0.5' },
  );
  connection.on('reconnect', () => { reconnectEvents++; });
  try {
    t.mock.timers.tick(10);
    await connection.reconnectAfterFailure();
    t.mock.timers.tick(10);
    await new Promise<void>(done => setImmediate(done));
    assert.equal(handshakes, 2, 'initial failure plus one actual in-flight reconnect');
    let settled = false;
    const stopped = connection.close().finally(() => { settled = true; });
    await new Promise<void>(done => setImmediate(done));
    assert.equal(settled, false, 'do not report success before an owned handshake settles');
    waiting.resolve(); await stopped;
    assert.equal(connection.isConnected, false);
    assert.equal(connection.willReconnect, false);
    assert.equal(reconnectEvents, 0, 'a late handshake must not reopen admission');
    assert.equal(transport.calls, 1);
    await connection.close();
    assert.equal(transport.calls, 1);
  } finally {
    waiting.resolve();
    await new Promise<void>(done => setImmediate(done));
    await connection.close();
  }
});

for (const closeFails of [false, true]) {
  test(`pending MCPL reconnect remains owned across timeout (closeFails=${closeFails})`, async t => {
    const waiting = deferred();
    const failure = new Error('late transport close failure');
    const transport = new ControlledTransport(async () => {
      if (closeFails && transport.calls === 1) throw failure;
    });
    t.mock.method(McplServerConnection as any, 'handshake', async () => {
      await waiting.promise;
      return { transport, capabilities: null, droppedCapabilities: new Set(), mcpToolsAdvertised: false };
    });
    const connection = Reflect.construct(McplServerConnection, ['late', null, null]) as McplServerConnection;
    const internals = connection as any;
    internals.closed = true; internals.reconnectEnabled = true;
    internals.config = { id: 'late', command: 'unused', reconnect: true };
    internals.hostCapabilities = { version: '0.5' };
    const reconnecting = internals.attemptReconnect();
    const registry = new McplServerRegistry();
    (registry as any).servers.set('late', connection);
    try {
      await assert.rejects(registry.closeAll(15), error => error instanceof ShutdownTimeoutError &&
        error.pending.includes('mcpl:late'));
      assert.equal(registry.getServer('late'), connection);
      const observedClose = connection.close().then(() => undefined, error => error);
      waiting.resolve(); await reconnecting;
      assert.equal(await observedClose, closeFails ? failure : undefined);
      await new Promise<void>(done => setImmediate(done));
      assert.equal(connection.isConnected, false);
      assert.equal(transport.calls, 1);
      if (closeFails) assert.equal(registry.getServer('late'), connection);
      await registry.closeAll(1000);
      assert.equal(registry.getAllServers().length, 0);
      assert.equal(transport.calls, closeFails ? 2 : 1);
    } finally {
      waiting.resolve(); await reconnecting;
      await connection.close();
    }
  });
}


test('late overlapping public reconnect cannot defeat a completed close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0.5);
  const first = deferred(), second = deferred();
  const a = new ControlledTransport(async () => {}), b = new ControlledTransport(async () => {});
  let handshakes = 0;
  t.mock.method(McplServerConnection as any, 'handshake', async () => {
    const ordinal = ++handshakes;
    if (ordinal === 1) throw new Error('initial connect failure');
    await (ordinal === 2 ? first.promise : second.promise);
    return { transport: ordinal === 2 ? a : b, capabilities: null,
      droppedCapabilities: new Set(), mcpToolsAdvertised: false };
  });
  const connection = await McplServerConnection.connectWithReconnect(
    { id: 'late-overlap', command: 'unused', reconnect: true, reconnectIntervalMs: 10 }, { version: '0.5' },
  );
  try {
    t.mock.timers.tick(10);
    await connection.reconnectAfterFailure();
    t.mock.timers.tick(10);
    first.resolve();
    await new Promise<void>(done => setImmediate(done));
    assert.equal(connection.isConnected, true);
    await connection.close();
    second.resolve();
    await new Promise<void>(done => setImmediate(done));
    await connection.close();
    assert.equal(connection.isConnected, false, 'successful close cannot become stale after a late handshake');
    assert.equal(a.calls, 1);
    assert.equal(b.calls, handshakes > 2 ? 1 : 0);
  } finally {
    first.resolve(); second.resolve();
    await new Promise<void>(done => setImmediate(done));
    await connection.close();
  }
});


test('queued MCPL recovery after successful reconnect cannot replace an owned live transport', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0.5);
  const first = deferred(), second = deferred();
  const a = new ControlledTransport(async () => {}), b = new ControlledTransport(async () => {});
  let handshakes = 0;
  t.mock.method(McplServerConnection as any, 'handshake', async () => {
    const ordinal = ++handshakes;
    if (ordinal === 1) throw new Error('initial connect failure');
    await (ordinal === 2 ? first.promise : second.promise);
    return { transport: ordinal === 2 ? a : b, capabilities: null,
      droppedCapabilities: new Set(), mcpToolsAdvertised: false };
  });
  const connection = await McplServerConnection.connectWithReconnect(
    { id: 'queued', command: 'unused', reconnect: true, reconnectIntervalMs: 10 }, { version: '0.5' },
  );
  try {
    t.mock.timers.tick(10);
    await connection.reconnectAfterFailure();
    first.resolve();
    await new Promise<void>(done => setImmediate(done));
    assert.equal(connection.isConnected, true);
    // B's timer fires after A recovered and its in-flight promise cleared.
    t.mock.timers.tick(10);
    const stopped = connection.close();
    second.resolve(); await stopped;
    await connection.close();
    assert.equal(connection.isConnected, false);
    assert.equal(a.calls, 1, 'the already recovered transport must actually be closed');
    assert.equal(handshakes, 2, 'discard a queued recovery after the connection recovered');
    assert.equal(b.calls, 0, 'the stale timer must not open a second transport');
  } finally {
    first.resolve(); second.resolve();
    await new Promise<void>(done => setImmediate(done));
    await connection.close();
  }
});
