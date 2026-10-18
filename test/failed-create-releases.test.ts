/**
 * A create() that fails releases what it had acquired before its error reaches
 * the caller, so the caller can retry it in the same process (#389).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework, type Module } from '../src/index.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { DiscordAwarenessOutbox } from '../src/recovery/discord-awareness-outbox.js';
import { MockMembrane } from './helpers/mock-membrane.js';

function recordingModule(name: string, stop: () => Promise<void> = async () => {}, start: () => Promise<void> = async () => {}) {
  const calls: string[] = [];
  const module: Module = {
    name,
    async start() { calls.push('start'); await start(); },
    async stop() { calls.push('stop'); await stop(); },
    async onProcess() { return {}; },
    getTools: () => [],
    async handleToolCall() { throw new Error('No tool calls expected'); },
  };
  return { module, calls };
}

function tempDir(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'failed-create-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseConfig(storePath: string) {
  return { storePath, membrane: new MockMembrane().asMembrane(), agents: [], modules: [] as Module[],
    syncIntervalMs: 0, maintenanceIntervalMs: 0 };
}

/** A release that finished cleanly rejects with create()'s own error, unwrapped. */
function rejectsWithItsOwnError(creating: Promise<unknown>, message: string | RegExp) {
  return assert.rejects(creating, (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof AggregateError), `expected create()'s own error, got ${String(error)}`);
    if (typeof message === 'string') assert.equal(error.message, message);
    else assert.match(error.message, message);
    return true;
  });
}

// Two servers on one prefix: refused after the modules have started, before
// any MCPL server is spawned (the reproduction in #389).
const COLLIDING_SERVERS = [
  { id: 'first', command: process.execPath, args: ['-e', ''], toolPrefix: 'shared' },
  { id: 'second', command: process.execPath, args: ['-e', ''], toolPrefix: 'shared' },
];
const COLLISION = 'MCPL server "second" toolPrefix "shared" collides with server "first"';

test('a create() refused after its modules started stops them and frees its store', async t => {
  const storePath = join(tempDir(t), 'store');
  const { module, calls } = recordingModule('started');
  await rejectsWithItsOwnError(
    AgentFramework.create({ ...baseConfig(storePath), modules: [module], mcplServers: COLLIDING_SERVERS }),
    COLLISION,
  );
  assert.deepEqual(calls, ['start', 'stop']);
  const retried = await AgentFramework.create(baseConfig(storePath));
  await retried.stop();
});

test('a create() whose module fails to start stops every module it started, that one included', async t => {
  const storePath = join(tempDir(t), 'store');
  const first = recordingModule('first');
  const failing = recordingModule('failing', undefined, async () => { throw new Error('the port is taken'); });
  await rejectsWithItsOwnError(
    AgentFramework.create({ ...baseConfig(storePath), modules: [first.module, failing.module] }),
    'the port is taken',
  );
  assert.deepEqual(first.calls, ['start', 'stop']);
  assert.deepEqual(failing.calls, ['start', 'stop']);
  const retried = await AgentFramework.create(baseConfig(storePath));
  await retried.stop();
});

test('a create() that fails after its MCPL server connected closes the server and frees its store', async t => {
  const dir = tempDir(t);
  const outboxPath = join(dir, 'awareness.json');
  // A pending Discord awareness batch makes startup run the awareness barrier
  // after the server connects; its second reconciliation fails.
  const outbox = new DiscordAwarenessOutbox(outboxPath);
  const batch = outbox.prepare({ agentName: 'assistant', sourceBranch: 'source', targetBranch: 'main',
    activationPolicy: 'explicit',
    refs: [{ serverId: 'discord', channelId: 'discord:guild:startup', messageId: 'message-1' }] });
  assert.ok(batch);
  outbox.activate(batch.id);
  const config = {
    ...baseConfig(join(dir, 'store')),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
    discordAwarenessOutboxPath: outboxPath,
    discordAwarenessDeadlineMs: 1_000,
    mcplServers: [{
      id: 'discord', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/awareness-barrier-mcpl-server.mjs', import.meta.url))],
      requestTimeoutMs: 1_000, enabledFeatureSets: ['chat'],
      env: { STATUS_PATH: join(dir, 'status.jsonl'), LEDGER_PATH: outboxPath },
    }],
  };
  const reconcile = DiscordAwarenessOutbox.prototype.reconcileForBranch;
  let reconciliations = 0;
  const injected = t.mock.method(DiscordAwarenessOutbox.prototype, 'reconcileForBranch',
    function (this: DiscordAwarenessOutbox, ...args: Parameters<typeof reconcile>) {
      if (++reconciliations === 2) throw new Error('injected reconcile failure');
      return reconcile.apply(this, args);
    });
  await rejectsWithItsOwnError(AgentFramework.create(config),
    /^Discord awareness accounting failed during .*: injected reconcile failure$/);
  injected.mock.restore();
  const initialized = readFileSync(join(dir, 'status.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { event: string; pid?: number })
    .find(record => record.event === 'initialized');
  assert.ok(initialized?.pid, 'the MCPL server had finished its handshake before the failure');
  // Wait on that child itself, with room for a loaded machine: only a child
  // still running after 10 s fails this.
  const running = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  };
  for (let waits = 0; running(initialized.pid); waits++) {
    assert.ok(waits < 1000, 'the MCPL server is still running after create() rejected');
    await new Promise(done => setTimeout(done, 10));
  }
  const retried = await AgentFramework.create(config);
  await retried.stop();
});

test('a create() refused before the framework is built frees its store', async t => {
  const storePath = join(tempDir(t), 'store');
  await rejectsWithItsOwnError(
    AgentFramework.create({ ...baseConfig(storePath), timeZone: 'Not/AZone' }),
    'Invalid IANA time zone: "Not/AZone"',
  );
  const retried = await AgentFramework.create(baseConfig(storePath));
  await retried.stop();
});

test('a failed create() leaves a store the caller owns open, and stops what it started', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'failed-create-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  t.after(() => { try { store.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  const { module, calls } = recordingModule('started');
  const { storePath: _unused, ...config } = baseConfig('');
  await rejectsWithItsOwnError(
    AgentFramework.create({ ...config, store, modules: [module], mcplServers: COLLIDING_SERVERS }),
    COLLISION,
  );
  assert.deepEqual(calls, ['start', 'stop']);
  assert.equal(store.isClosed(), false);
  await rejectsWithItsOwnError(
    AgentFramework.create({ ...config, store, timeZone: 'Not/AZone' }),
    'Invalid IANA time zone: "Not/AZone"',
  );
  assert.equal(store.isClosed(), false);
  const retried = await AgentFramework.create({ ...config, store });
  await retried.stop();
});

test('a failed create() whose module fails to stop reports both, and still frees its store', async t => {
  const storePath = join(tempDir(t), 'store');
  const { module } = recordingModule('stuck', async () => { throw new Error('the socket would not close'); });
  await assert.rejects(
    AgentFramework.create({ ...baseConfig(storePath), modules: [module], mcplServers: COLLIDING_SERVERS }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError, `expected an AggregateError, got ${String(error)}`);
      assert.equal(error.message, `AgentFramework.create() failed: ${COLLISION}. Stopping what it had started ` +
        `didn't finish, so part of it may still be running: the socket would not close`);
      assert.equal((error.errors[0] as Error).message, COLLISION);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
  const retried = await AgentFramework.create(baseConfig(storePath));
  await retried.stop();
});

test('a failed create() whose store fails to close says so, after its own error', async t => {
  const storePath = join(tempDir(t), 'store');
  const { module } = recordingModule('stuck', async () => { throw new Error('the socket would not close'); });
  // The store does close, so the retry below can open it; close() then reports
  // a failure, as a close whose final sync fails would.
  const close = JsStore.prototype.close;
  const failing = t.mock.method(JsStore.prototype, 'close', function (this: JsStore) {
    failing.mock.restore();
    close.call(this);
    throw new Error('the final sync failed');
  });
  await assert.rejects(
    AgentFramework.create({ ...baseConfig(storePath), modules: [module], mcplServers: COLLIDING_SERVERS }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError, `expected an AggregateError, got ${String(error)}`);
      assert.equal(error.message, `AgentFramework.create() failed: ${COLLISION}. Stopping what it had started ` +
        `didn't finish, so part of it may still be running: the socket would not close. Closing its store ` +
        `failed, so the store may still be locked: the final sync failed`);
      assert.deepEqual(error.errors.map(e => (e as Error).message),
        [COLLISION, 'the socket would not close', 'the final sync failed']);
      return true;
    },
  );
  const retried = await AgentFramework.create(baseConfig(storePath));
  await retried.stop();
});

test('a failed create() whose stop fails only at the end says nothing it started is still running', async t => {
  const storePath = join(tempDir(t), 'store');
  const { module, calls } = recordingModule('clean');
  // Once everything it waits on has stopped, stop() closes the store itself.
  // That close fails without closing, as a close whose final sync fails before
  // the handle goes would, and the release's own close then succeeds.
  const failing = t.mock.method(JsStore.prototype, 'close', function (this: JsStore) {
    failing.mock.restore();
    throw new Error('the final sync failed');
  });
  await assert.rejects(
    AgentFramework.create({ ...baseConfig(storePath), modules: [module], mcplServers: COLLIDING_SERVERS }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError, `expected an AggregateError, got ${String(error)}`);
      assert.equal(error.message, `AgentFramework.create() failed: ${COLLISION}. What it had started stopped, ` +
        `but finishing the stop failed: the final sync failed`);
      assert.deepEqual(error.errors.map(e => (e as Error).message), [COLLISION, 'the final sync failed']);
      return true;
    },
  );
  assert.deepEqual(calls, ['start', 'stop']);
  const retried = await AgentFramework.create(baseConfig(storePath));
  await retried.stop();
});

test('a failed create() gives up on a module\'s stop after 30 s, and says what did not finish', async t => {
  const storePath = join(tempDir(t), 'store');
  let release!: () => void;
  const stopping = new Promise<void>(done => { release = done; });
  t.after(() => release());
  const { module, calls } = recordingModule('hung', () => stopping);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const rejection = AgentFramework.create({ ...baseConfig(storePath), modules: [module], mcplServers: COLLIDING_SERVERS })
    .then(() => assert.fail('create() should fail'), (error: unknown) => error)
    .finally(() => { settled = true; });
  // The module's stop() is called once the release's deadline is armed.
  for (let turns = 0; !calls.includes('stop'); turns++) {
    assert.ok(turns < 1000, 'the release never reached the module');
    await new Promise(done => setImmediate(done));
  }
  t.mock.timers.tick(29_999);
  await new Promise(done => setImmediate(done));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  for (let turns = 0; !settled; turns++) {
    assert.ok(turns < 1000, 'create() still waits on its release after 30 s');
    await new Promise(done => setImmediate(done));
  }
  const error = await rejection;
  assert.ok(error instanceof AggregateError, `expected an AggregateError, got ${String(error)}`);
  assert.equal(error.message, `AgentFramework.create() failed: ${COLLISION}. Stopping what it had started ` +
    `didn't finish, so part of it may still be running: Shutdown timed out after 30000 ms; pending: module:hung`);
  t.mock.timers.reset();
  const retried = await AgentFramework.create(baseConfig(storePath));
  await retried.stop();
});

// The watchdog's worker kills the whole process once the main thread stops
// beating for its threshold. One a failed create() left running would kill a
// process that carried on after the failure.
test('a create() refused after it started the watchdog leaves none to kill the process later', async t => {
  const dir = tempDir(t);
  const script = join(dir, 'child.mjs');
  const index = pathToFileURL(join(import.meta.dirname, '../src/index.js')).href;
  const membrane = pathToFileURL(join(import.meta.dirname, 'helpers/mock-membrane.js')).href;
  writeFileSync(script, `
    import { AgentFramework } from ${JSON.stringify(index)};
    import { MockMembrane } from ${JSON.stringify(membrane)};
    const refusal = await AgentFramework.create({
      storePath: ${JSON.stringify(join(dir, 'store'))}, membrane: new MockMembrane().asMembrane(),
      agents: [], modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      watchdog: { enabled: true, thresholdMs: 2000, action: 'exit' },
      toolResultInlineMaxChars: 1,
    }).then(() => 'none', error => error.message);
    console.error('refused: ' + refusal);
    await new Promise(done => setTimeout(done, 200));
    const end = Date.now() + 5000;
    while (Date.now() < end) {}
    process.exit(0);
  `);
  // A file, not a pipe: writes to it are synchronous on every platform, so a
  // killed child's lines are all there.
  const logPath = join(dir, 'child.log');
  const log = openSync(logPath, 'w');
  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    const child = spawn(process.execPath, [script], { stdio: ['ignore', log, log] });
    const safety = setTimeout(() => child.kill('SIGTERM'), 20_000);
    child.on('exit', (code, signal) => { clearTimeout(safety); resolve({ code, signal }); });
  });
  closeSync(log);
  const output = readFileSync(logPath, 'utf8');
  assert.match(output, /\[liveness-watchdog\] armed/, 'the watchdog started before the refusal');
  assert.match(output, /refused: FrameworkConfig\.toolResultInlineMaxChars must be a number >= 1000/);
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
});

test('a failed create() on a restart leaves the workspace\'s saved pins as they were', async t => {
  const dir = tempDir(t);
  const storePath = join(dir, 'store');
  const mountDir = join(dir, 'mount');
  mkdirSync(mountDir);
  const workspace = () => new WorkspaceModule({ mounts: [{ name: 'work', path: mountDir, mode: 'read-write', watch: 'never' }] });
  const savedState = () => {
    const store = JsStore.openOrCreate({ path: storePath });
    try { return store.getStateJson('modules/workspace/state'); } finally { store.close(); }
  };

  // A session that materializes, so its stop() saves the branch it pinned.
  const first = workspace();
  const framework = await AgentFramework.create({ ...baseConfig(storePath), modules: [first] });
  first.initStore(framework.getStore());
  let result = await first.handleToolCall({ id: 'w', name: 'write', input: { path: 'work/one.txt', content: 'one' } });
  assert.equal(result.success, true, `write failed: ${result.error}`);
  result = await first.handleToolCall({ id: 'm', name: 'materialize', input: {} });
  assert.equal(result.success, true, `materialize failed: ${result.error}`);
  await framework.stop();
  const pinned = savedState() as { mounts: { work?: { lastMaterializedBranchId?: string } } };
  assert.ok(pinned.mounts.work?.lastMaterializedBranchId, 'the session saved a pin');

  // A restart refused after the workspace module started, so before the host
  // could call its initStore().
  await rejectsWithItsOwnError(
    AgentFramework.create({ ...baseConfig(storePath), modules: [workspace()], mcplServers: COLLIDING_SERVERS }),
    COLLISION,
  );
  assert.deepEqual(savedState(), pinned, 'the saved state is as the session left it');
});
