/**
 * The modern engine (room-284, shelf-487) over stdio, against an SDK 2.x
 * fixture that refuses legacy openings, as the house services do. What
 * Connectome owns here, rather than the SDK:
 * - one launch per connect, through Connectome's own spawner (env allowlist,
 *   stderr), instead of the SDK's sibling-probe launch;
 * - one deadline per call, which ends as `no-response` with cancellation
 *   requested, and is never replayed;
 * - results kept by presence (structured `0` is a value);
 * - reconnect with the legacy backoff settings, and list-change awareness;
 * - the request-outcome contract on failures.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModernMcpConnection } from '../src/mcpl/modern-connection.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import type { McplServerConfig } from '../src/mcpl/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'fixtures', 'modern-mcp-server.mjs');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'modern-mcp-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const until = async (cond: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), 'condition reached in time');
};

function config(dir: string, extra: Partial<McplServerConfig> = {}): McplServerConfig {
  return {
    id: 'modern',
    command: process.execPath,
    args: [SERVER, join(dir, 'starts.log'), join(dir, 'events.log')],
    protocol: 'modern',
    ...extra,
  };
}

async function connect(c: McplServerConfig): Promise<ModernMcpConnection> {
  const connection = await ModernMcpConnection.connect(c);
  cleanups.push(() => connection.close());
  return connection;
}

test('connects once over Connectome\'s spawner and speaks 2026-07-28', async () => {
  const dir = scratch();
  const stderr: string[] = [];
  const connection = await connect(config(dir));
  connection.on('stderr', ({ line }: { line: string }) => stderr.push(line));
  assert.equal(connection.isConnected, true);
  assert.equal(connection.protocolVersion, '2026-07-28');
  assert.equal(connection.transportKind, 'stdio');
  const names = (await connection.listTools()).map((t) => t.name);
  assert.ok(names.includes('echo') && names.includes('structured_only'), names.join());
  const echo = await connection.callTool('echo', { text: 'hi' });
  assert.deepEqual(echo.content, [{ type: 'text', text: 'echo:hi' }]);
  // In-place discovery: the SDK's sibling probe would have made this 2.
  assert.equal(lines(join(dir, 'starts.log')).length, 1);
  // The child's stderr surfaces as lines, as a legacy child's does.
  await connection.callTool('shout', { text: 'hello' });
  await until(() => stderr.includes('shout: hello'));
});

test('the child gets the env allowlist plus declared env, as legacy children do', async () => {
  const dir = scratch();
  process.env.FIXTURE_HOST_ONLY = 'leaked';
  cleanups.push(() => { delete process.env.FIXTURE_HOST_ONLY; });
  const connection = await connect(config(dir, { env: { FIXTURE_DECLARED: 'yes' } }));
  const result = await connection.callTool('env', {});
  const seen = JSON.parse((result.content[0] as { text: string }).text);
  assert.deepEqual(seen, { declared: 'yes', hostOnly: null, path: true });
});

test('results are kept by presence: structured-only, falsy structured, tool errors', async () => {
  const connection = await connect(config(scratch()));
  const only = await connection.callTool('structured_only', {});
  assert.deepEqual(only.content, []);
  assert.deepEqual(only.structuredContent, { answer: 42, ok: false, nothing: null });
  const zero = await connection.callTool('structured_zero', {});
  assert.ok('structuredContent' in zero);
  assert.equal(zero.structuredContent, 0);
  const plain = await connection.callTool('echo', { text: 'x' });
  assert.ok(!('structuredContent' in plain));
  const fail = await connection.callTool('fail', {});
  assert.equal(fail.isError, true);
});

test('a deadline requests cancellation and reports no-response, outcome unknown', async () => {
  const dir = scratch();
  const connection = await connect(config(dir, { requestTimeoutMs: 300 }));
  await connection.callTool('echo', { text: 'warm' }); // the slow call is not the connection's first request
  const started = Date.now();
  await assert.rejects(connection.callTool('slow', { ms: 2000 }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError);
    assert.equal(err.outcome, 'no-response');
    assert.match(err.message, /did not answer tools\/call "slow" within 300ms/);
    assert.match(err.message, /Cancellation was requested; the outcome is unknown/);
    return true;
  });
  assert.ok(Date.now() - started < 1500, 'rejected at the deadline, not at the tool\'s end');
  // The server saw the cancellation: the request was cancelled, not merely abandoned.
  await until(() => lines(join(dir, 'events.log')).includes('slow-aborted'));
});

test('a list change is announced, and the next listing has the new tool', async () => {
  const connection = await connect(config(scratch()));
  let changes = 0;
  connection.on('tools-list-changed', () => changes++);
  await connection.callTool('add_tool', {});
  await until(() => changes > 0);
  assert.ok((await connection.listTools()).some((t) => t.name === 'added_1'));
});

test('a lost child reconnects with backoff, relaunching once, and lists again', async () => {
  const dir = scratch();
  const connection = await connect(config(dir, { reconnect: true, reconnectIntervalMs: 50, reconnectMaxIntervalMs: 100 }));
  const events: string[] = [];
  connection.on('close', () => events.push('close'));
  connection.on('reconnect', () => events.push('reconnect'));
  await connection.callTool('die', {});
  await until(() => events.includes('reconnect'));
  assert.deepEqual(events, ['close', 'reconnect']);
  assert.equal(connection.isConnected, true);
  assert.ok((await connection.listTools()).some((t) => t.name === 'echo'));
  assert.equal(lines(join(dir, 'starts.log')).length, 2);
});

test('without reconnect a lost child stays down, and calls are refused before sending', async () => {
  const connection = await connect(config(scratch()));
  let closed = false;
  connection.on('close', () => { closed = true; });
  await connection.callTool('die', {});
  await until(() => closed);
  assert.equal(connection.isConnected, false);
  assert.equal(connection.willReconnect, false);
  await assert.rejects(connection.callTool('echo', { text: 'x' }), (err: unknown) => {
    assert.ok(err instanceof McplRequestError);
    assert.equal(err.outcome, 'not-sent');
    return true;
  });
});

test('a first connect that fails keeps retrying with reconnect, and close stops it', async () => {
  const dir = scratch();
  const failures: unknown[] = [];
  const connection = await connect({
    id: 'nothing',
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    protocol: 'modern',
    reconnect: true,
    reconnectIntervalMs: 30,
    reconnectMaxIntervalMs: 60,
  });
  connection.on('connect-failed', (e) => failures.push(e));
  connection.on('reconnect-failed', (e) => failures.push(e));
  assert.equal(connection.isConnected, false);
  await until(() => failures.length >= 2);
  await connection.close();
  const count = failures.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(failures.length, count, 'no attempts after close');
  void dir;
});

test('configuration mistakes throw before anything is launched', async () => {
  await assert.rejects(ModernMcpConnection.connect({ id: 'x', url: 'https://x.invalid/mcp', protocol: 'modern' }), /applies only to stdio/);
  await assert.rejects(ModernMcpConnection.connect({ id: 'x', command: 'srv', protocol: 'modern', requestTimeoutMs: 0 }), /requestTimeoutMs must be an integer/);
  await assert.rejects(ModernMcpConnection.connect({ id: 'x', command: 'srv' }), /not configured for modern MCP/);
});
