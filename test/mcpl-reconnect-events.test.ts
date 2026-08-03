/**
 * McplServerConnection reconnect lifecycle events.
 *
 * Covers the event contract the framework's wireMcplEvents turns into
 * mcpl:server-* trace events:
 *   - 'connect-failed'   buffered on the disconnected stub until ready()
 *   - 'reconnect-failed' per failed background attempt, with attempt ordinal
 *   - 'reconnect'        on revival, with the attempt count that succeeded
 *   - 'close'            with (code, signal) on unexpected child exit
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { McplServerConnection } from '../src/mcpl/server-connection.js';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

// The .mjs fixture is not compiled/copied by tsc, so when this test runs from
// dist/test it must reach back into the source tree for it.
const FIXTURE = [
  join(import.meta.dirname, 'fixtures/flaky-mcpl-server.mjs'),
  join(import.meta.dirname, '../../test/fixtures/flaky-mcpl-server.mjs'),
].find((p) => existsSync(p))!;
const TMP_DIR = join(import.meta.dirname, '../.test-tmp-reconnect');
const FLAG_FILE = join(TMP_DIR, 'server-healthy');

const HOST_CAPS: McplHostCapabilities = {
  version: '0.4',
  pushEvents: true,
  contextHooks: { beforeInference: true },
  featureSets: true,
};

function makeConfig(overrides?: Partial<McplServerConfig>): McplServerConfig {
  return {
    id: 'flaky',
    command: process.execPath,
    args: [FIXTURE, FLAG_FILE],
    reconnect: true,
    reconnectIntervalMs: 50,
    ...overrides,
  };
}

/** Poll until `predicate` returns true or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

let connection: McplServerConnection | null = null;

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await connection?.close();
  connection = null;
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('McplServerConnection — reconnect lifecycle events', () => {
  it('buffers connect-failed on the stub, emits reconnect-failed per retry, then reconnect on recovery', async () => {
    // Flag file absent: the initial connect fails and we get a stub.
    connection = await McplServerConnection.connectWithReconnect(makeConfig(), HOST_CAPS);
    assert.strictEqual(connection.capabilities, null);

    const connectFailed: Array<{ error: string; attempt: number }> = [];
    const reconnectFailed: Array<{ error: string; attempt: number }> = [];
    const reconnected: Array<{ attempts: number }> = [];
    connection.on('connect-failed', (p: { error: string; attempt: number }) => connectFailed.push(p));
    connection.on('reconnect-failed', (p: { error: string; attempt: number }) => reconnectFailed.push(p));
    connection.on('reconnect', (p: { attempts: number }) => reconnected.push(p));

    // The initial failure fired before listeners existed — ready() flushes it.
    connection.ready();
    assert.strictEqual(connectFailed.length, 1);
    assert.strictEqual(connectFailed[0]!.attempt, 0);
    assert.match(connectFailed[0]!.error, /before handshake/);

    // At least one background retry fails while the server stays down.
    await waitFor(() => reconnectFailed.length >= 1, 5000, 'first reconnect-failed');
    assert.strictEqual(reconnectFailed[0]!.attempt, 1);

    // Bring the server up; the next attempt succeeds.
    writeFileSync(FLAG_FILE, '');
    await waitFor(() => reconnected.length === 1, 10_000, 'reconnect');
    assert.ok(
      reconnected[0]!.attempts >= 2,
      `reconnect should report the attempt ordinal that succeeded, got ${reconnected[0]!.attempts}`,
    );
    assert.strictEqual(connection.willReconnect, true);
  });

  it('emits close with (code, signal) on unexpected exit, then revives with attempts=1', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);

    const closes: Array<{ code: number | null; signal: string | null }> = [];
    const reconnected: Array<{ attempts: number }> = [];
    connection.on('close', (code?: number | null, signal?: string | null) =>
      closes.push({ code: code ?? null, signal: signal ?? null }));
    connection.on('reconnect', (p: { attempts: number }) => reconnected.push(p));
    connection.ready();

    // The fixture exits(7) when it receives tools/list — a remote-controlled
    // crash. The pending request rejects when the process dies.
    connection.sendToolsList().catch(() => {});

    await waitFor(() => closes.length === 1, 5000, 'close event');
    assert.strictEqual(closes[0]!.code, 7);
    assert.strictEqual(closes[0]!.signal, null);
    assert.strictEqual(connection.willReconnect, true);

    // The server is still healthy (flag file present), so the first retry wins.
    await waitFor(() => reconnected.length === 1, 5000, 'reconnect after crash');
    assert.strictEqual(reconnected[0]!.attempts, 1);
  });

  it('explicit close() disables reconnect and reports willReconnect=false', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    connection.ready();

    const reconnected: unknown[] = [];
    connection.on('reconnect', (p: unknown) => reconnected.push(p));

    assert.strictEqual(connection.willReconnect, true);
    await connection.close();
    assert.strictEqual(connection.willReconnect, false);

    // No revival after an explicit close.
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(reconnected.length, 0);
    connection = null;
  });
});
