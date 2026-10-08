/**
 * The legacy engine's protocol boundary and inventory (room-284, shelf-487):
 * - it offers and accepts exactly MCP 2024-11-05; anything else is a typed
 *   McplProtocolVersionError carrying what each side said;
 * - such a verdict is never retried (no reconnect stub, no backoff loop);
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

test('a version verdict gets no reconnect stub even with reconnect: true', async () => {
  await assert.rejects(
    McplServerConnection.connectWithReconnect(config('reject', { reconnect: true, reconnectIntervalMs: 20 }), HOST_CAPS),
    (err: unknown) => err instanceof McplProtocolVersionError,
  );
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
    ['nullcursor', /malformed tools\/list page 1: nextCursor must be a string, got null/],
  ] as const) {
    const connection = await connect(config('ok', { env: { MODE_LIST: mode } }));
    await assert.rejects(connection.sendToolsList(), pattern, mode);
  }
});

test('a repeating cursor is an error, not a silently partial inventory', async () => {
  const connection = await connect(config('ok', { env: { MODE_LIST: 'loop' } }));
  await assert.rejects(connection.sendToolsList(), /repeated tools\/list cursor "same"/);
});

test('a modern configuration is refused by the legacy engine before anything is dialed', async () => {
  await assert.rejects(
    McplServerConnection.connect({ id: 'modern', url: 'https://example.invalid/mcp' }, HOST_CAPS),
    /configured for modern MCP \(2026-07-28\); McplServerConnection speaks the legacy family/,
  );
  await assert.rejects(
    McplServerConnection.connect({ id: 'modern', command: process.execPath, protocol: 'modern' }, HOST_CAPS),
    /configured for modern MCP/,
  );
});
