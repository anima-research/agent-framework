/**
 * The legacy engine's protocol boundary and inventory:
 * - it offers and accepts exactly MCP 2024-11-05; anything else is a typed
 *   McplProtocolVersionError carrying what each side said;
 * - such a verdict is never retried (no reconnect stub, no backoff loop), and
 *   at startup it raises the ops alert at once, as it does on reconnect;
 * - tools/list follows nextCursor to the complete inventory, and refuses a
 *   server whose cursors don't terminate.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McplServerConnection, McplProtocolVersionError, McplRequestError } from '../src/mcpl/server-connection.js';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';
import { AgentFramework } from '../src/framework.js';
import type { Module, ModuleContext, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'fixtures', 'legacy-version-server.mjs');
const HOST_CAPS: McplHostCapabilities = { version: '0.5', pushEvents: true };

function config(mode: string, extra: Partial<McplServerConfig> = {}, startLog?: string): McplServerConfig {
  return {
    id: 'legacy',
    command: process.execPath,
    args: [SERVER, mode, ...(startLog ? [startLog] : [])],
    ...extra,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect(c: McplServerConfig): Promise<McplServerConnection> {
  const connection = await McplServerConnection.connect(c, HOST_CAPS);
  cleanups.push(() => connection.close());
  connection.ready();
  return connection;
}

test('a 2024-11-05 answer establishes the connection and records its revision', async () => {
  const connection = await connect(config('ok'));
  assert.equal(connection.protocolVersion, '2024-11-05');
});

test('-32022 with a supported list is a typed rejection naming the modern remedy', async () => {
  await assert.rejects(McplServerConnection.connect(config('reject'), HOST_CAPS), (err: unknown) => {
    assert.ok(err instanceof McplProtocolVersionError);
    assert.equal(err.kind, 'rejected');
    assert.equal(err.offered, '2024-11-05');
    assert.deepEqual(err.supported, ['2026-07-28']);
    assert.equal(err.code, -32022);
    assert.deepEqual(err.data, { supported: ['2026-07-28'], requested: '2024-11-05' });
    assert.match(err.message, /does not support MCP 2024-11-05 \(it supports: 2026-07-28\)/);
    assert.match(err.message, /protocol: 'modern'/);
    // A negotiation verdict, not a request outcome.
    assert.ok(!(err instanceof McplRequestError));
    return true;
  });
});

test('-32022 without data still rejects, with the server\'s own message', async () => {
  await assert.rejects(McplServerConnection.connect(config('reject-nodata'), HOST_CAPS), (err: unknown) => {
    assert.ok(err instanceof McplProtocolVersionError);
    assert.equal(err.kind, 'rejected');
    assert.equal(err.supported, null);
    assert.match(err.message, /Unsupported protocol version: 2024-11-05/);
    assert.doesNotMatch(err.message, /protocol: 'modern'/);
    return true;
  });
});

test('another legacy revision, or none, is a mismatch rather than a silent connection', async () => {
  await assert.rejects(McplServerConnection.connect(config('mismatch'), HOST_CAPS), (err: unknown) => {
    assert.ok(err instanceof McplProtocolVersionError);
    assert.equal(err.kind, 'mismatch');
    assert.equal(err.returned, '2025-06-18');
    assert.match(err.message, /protocolVersion "2025-06-18"; this client's legacy engine speaks only 2024-11-05/);
    return true;
  });
  await assert.rejects(McplServerConnection.connect(config('missing'), HOST_CAPS), (err: unknown) => {
    assert.ok(err instanceof McplProtocolVersionError);
    assert.equal(err.kind, 'mismatch');
    assert.equal(err.returned, null);
    assert.match(err.message, /protocolVersion \(none\)/);
    return true;
  });
});

test('a version verdict on reconnect stops the backoff loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-version-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const startLog = join(dir, 'starts.log');
  const connection = await McplServerConnection.connectWithReconnect(
    config('ok-then-reject', { reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 }, startLog),
    HOST_CAPS,
  );
  cleanups.push(() => connection.close());
  connection.ready();
  const failures: Array<{ error: string; attempt: number; permanent?: boolean }> = [];
  connection.on('reconnect-failed', (info) => failures.push(info));

  // The first process answers 2024-11-05; make it exit so the loop runs.
  await assert.rejects(connection.sendToolsCall('die', {}));
  const deadline = Date.now() + 5_000;
  while (failures.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(failures.length, 1, 'one failed reconnect');
  assert.equal(failures[0]!.permanent, true);
  assert.match(failures[0]!.error, /does not support MCP 2024-11-05/);
  assert.equal(connection.willReconnect, false);

  // No further attempts: the start count stays at 2 (original + one retry).
  await new Promise((r) => setTimeout(r, 300));
  const starts = existsSync(startLog) ? readFileSync(startLog, 'utf8').split('\n').filter(Boolean).length : 0;
  assert.equal(starts, 2);
  assert.equal(failures.length, 1);
});

test('a version verdict at startup raises the ops alert at once, as on reconnect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-version-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // Modules start before the MCP servers connect, so this one sees startup.
  const traces: TraceEvent[] = [];
  const watcher: Module = {
    name: 'trace-watcher',
    async start(ctx: ModuleContext) { ctx.onTrace((event) => traces.push(event)); },
    async stop() {},
    getTools: (): ToolDefinition[] => [],
    handleToolCall: async (): Promise<ToolResult> => ({ success: false, error: 'no tools', isError: true }),
    onProcess: async () => ({}),
  };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: { complete: async () => { throw new Error('not used'); } } as unknown as import('@animalabs/membrane').Membrane,
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [watcher],
    mcplServers: [config('missing', { reconnect: true })],
  });
  cleanups.push(() => framework.stop());
  const failed = traces.find((t) => t.type === 'mcpl:server-connect-failed') as { serverId?: string; willRetry?: boolean } | undefined;
  assert.equal(failed?.serverId, 'legacy');
  assert.equal(failed?.willRetry, false);
  const alert = traces.find((t) => t.type === 'ops:alert') as { kind?: string; agentName?: string; message?: string } | undefined;
  assert.equal(alert?.kind, 'mcpl-down');
  assert.equal(alert?.agentName, 'legacy');
  assert.match(alert?.message ?? '', /not connected at startup, and this host won't retry it on its own: .*protocolVersion \(none\)/);
});

test('tools/list follows nextCursor to the complete inventory', async () => {
  const connection = await connect(config('ok'));
  const { tools } = await connection.sendToolsList();
  assert.deepEqual(tools.map((t) => t.name), ['a1', 'a2', 'b1', 'c1', 'die']);
});

test('an empty-string cursor is a cursor: only an absent nextCursor ends the inventory', async () => {
  const connection = await connect(config('ok', { env: { MODE_LIST: 'empty' } }));
  const { tools } = await connection.sendToolsList();
  assert.deepEqual(tools.map((t) => t.name), ['first', 'second']);
});

test('a malformed page is an error, never a partial or empty inventory', async () => {
  for (const [mode, pattern] of [
    ['notools', /malformed tools\/list page 1: no tools array/],
    ['badcursor', /malformed tools\/list page 1: nextCursor must be a string, got 5/],
  ] as const) {
    const connection = await connect(config('ok', { env: { MODE_LIST: mode } }));
    await assert.rejects(connection.sendToolsList(), pattern, mode);
  }
});

test('a null nextCursor ends the inventory, as an absent one does', async () => {
  const connection = await connect(config('ok', { env: { MODE_LIST: 'nullcursor' } }));
  const { tools } = await connection.sendToolsList();
  assert.deepEqual(tools.map((t) => t.name), ['x']);
});

test('a repeating cursor is an error, not a silently partial inventory', async () => {
  const connection = await connect(config('ok', { env: { MODE_LIST: 'loop' } }));
  await assert.rejects(connection.sendToolsList(), /repeated tools\/list cursor "same"/);
});

test('a modern configuration is refused by the legacy engine before anything is dialed or spawned', async () => {
  await assert.rejects(
    McplServerConnection.connect({ id: 'modern', url: 'https://example.invalid/mcp' }, HOST_CAPS),
    /configured for modern MCP \(2026-07-28\); McplServerConnection speaks the legacy family/,
  );
  const dir = mkdtempSync(join(tmpdir(), 'legacy-version-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const startLog = join(dir, 'starts.log');
  await assert.rejects(
    McplServerConnection.connect(config('ok', { protocol: 'modern' }, startLog), HOST_CAPS),
    /configured for modern MCP/,
  );
  await assert.rejects(
    McplServerConnection.connectWithReconnect(config('ok', { protocol: 'modern', reconnect: true }, startLog), HOST_CAPS),
    /configured for modern MCP/,
  );
  assert.equal(existsSync(startLog), false, 'the fixture was never spawned');
  // The same fixture, configured as legacy, does start: the log above can tell.
  await connect(config('ok', {}, startLog));
  assert.equal(readFileSync(startLog, 'utf8').split('\n').filter(Boolean).length, 1);
});

test('a -32022 whose supported list lacks the modern revision names no modern remedy', async () => {
  await assert.rejects(McplServerConnection.connect(config('reject-old'), HOST_CAPS), (err: unknown) => {
    assert.ok(err instanceof McplProtocolVersionError);
    assert.deepEqual(err.supported, ['2025-03-26']);
    assert.match(err.message, /it supports: 2025-03-26/);
    assert.doesNotMatch(err.message, /protocol: 'modern'/);
    return true;
  });
});

function startsIn(startLog: string): string[] {
  return existsSync(startLog) ? readFileSync(startLog, 'utf8').split('\n').filter(Boolean) : [];
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('a version verdict is never retried: one launch, and that child is reaped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-version-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const mode of ['reject', 'mismatch']) {
    const startLog = join(dir, `${mode}.log`);
    await assert.rejects(
      McplServerConnection.connectWithReconnect(config(mode, { reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 }, startLog), HOST_CAPS),
      (err: unknown) => err instanceof McplProtocolVersionError,
    );
    const starts = startsIn(startLog);
    assert.equal(starts.length, 1, `${mode}: launched once`);
    // The rejection waits for the handshake's own cleanup, so its child is gone.
    const pid = Number(starts[0]!.split(' ')[1]);
    assert.equal(alive(pid), false, `${mode}: its child was reaped`);
    // Past several reconnect intervals, nothing has launched again.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(startsIn(startLog).length, 1, `${mode}: never retried`);
  }
});

test('an initialize error that is not a version verdict stays a plain, retryable error', async () => {
  await assert.rejects(McplServerConnection.connect(config('error'), HOST_CAPS), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof McplProtocolVersionError));
    assert.match(err.message, /initialize failed on purpose/);
    return true;
  });
  // With reconnect, it leaves a stub that keeps trying, as any transient failure does.
  const stub = await McplServerConnection.connectWithReconnect(config('error', { reconnect: true, reconnectIntervalMs: 20 }), HOST_CAPS);
  cleanups.push(() => stub.close());
  assert.equal(stub.willReconnect, true);
});

test('a list that never ends is refused after its page bound', async () => {
  const connection = await connect(config('ok', { env: { MODE_LIST: 'endless' } }));
  await assert.rejects(connection.sendToolsList(), /did not finish within 100 pages/);
});

test('a page after the first is checked as the first is', async () => {
  const connection = await connect(config('ok', { env: { MODE_LIST: 'badlater' } }));
  await assert.rejects(connection.sendToolsList(), /malformed tools\/list page 2: no tools array/);
});

async function startupTraces(dir: string, server: McplServerConfig): Promise<TraceEvent[]> {
  const traces: TraceEvent[] = [];
  const watcher: Module = {
    name: 'trace-watcher',
    async start(ctx: ModuleContext) { ctx.onTrace((event) => traces.push(event)); },
    async stop() {},
    getTools: (): ToolDefinition[] => [],
    handleToolCall: async (): Promise<ToolResult> => ({ success: false, error: 'no tools', isError: true }),
    onProcess: async () => ({}),
  };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: { complete: async () => { throw new Error('not used'); } } as unknown as import('@animalabs/membrane').Membrane,
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [watcher],
    mcplServers: [server],
  });
  cleanups.push(() => framework.stop().catch(() => {}));
  return traces;
}

test('at startup, willRetry follows reconnect and the verdict, and every failure nothing will retry raises the alert', async () => {
  const cases: Array<[string, McplServerConfig, boolean, boolean]> = [
    // [label, config, willRetry, alert]
    ['verdict without reconnect', config('missing'), false, true],
    ['failure with reconnect', config('error', { reconnect: true }), true, false],
    ['failure without reconnect', config('error'), false, true],
    // Refused before anything launches: nothing will retry it, reconnect or not.
    ['configuration refused, with reconnect', { id: 'legacy', url: 'ftp://127.0.0.1/x', reconnect: true }, false, true],
  ];
  for (const [label, server, willRetry, alert] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-version-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const traces = await startupTraces(dir, server);
    const failed = traces.find((t) => t.type === 'mcpl:server-connect-failed') as { willRetry?: boolean } | undefined;
    assert.equal(failed?.willRetry, willRetry, label);
    assert.equal(traces.filter((t) => t.type === 'ops:alert' && t.kind === 'mcpl-down').length, alert ? 1 : 0, `${label}: alert`);
  }
});
