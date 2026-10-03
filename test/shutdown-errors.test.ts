import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, type Module } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { McplServerConnection } from '../src/mcpl/server-connection.js';

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

test('module stop failure waits for other modules before final sync and close', async t => {
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
  assert.deepEqual(order, ['failed', 'delayed-stopped', 'sync', 'close']);
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
    assert.deepEqual(order, ['connection-closed', 'sync', 'close']);
    assert.equal(registry.getAllServers().length, 0);
  });
}
