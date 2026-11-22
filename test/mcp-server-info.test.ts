/**
 * What a server says it is: each engine keeps the name and the version that
 * the server's handshake gives in MCP's `serverInfo`, redacted and on one
 * line, and a server's row in listMcplServers() carries them, so a host can
 * tell which release of a server it talks to. A later handshake replaces them.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Membrane } from '@animalabs/membrane';

import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { ModernMcpConnection } from '../src/mcpl/modern-connection.js';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';
import { AgentFramework } from '../src/framework.js';

const here = dirname(fileURLToPath(import.meta.url));
const LEGACY = join(here, 'fixtures', 'legacy-version-server.mjs');
const RAW = join(here, 'fixtures', 'modern-raw-server.mjs');
const SDK = join(here, 'fixtures', 'modern-mcp-server.mjs');
const HOST_CAPS: McplHostCapabilities = { version: '0.5', pushEvents: true };
const RECONNECT = { reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 40 } as const;
const TOKEN = 'Kq7vR2mXp9LwT4sB8nYd';
const LONGER_THAN_ANY_START_MS = 60_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'server-info-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + LONGER_THAN_ANY_START_MS;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), `${what}, within ${LONGER_THAN_ANY_START_MS} ms`);
}

const info = (name: unknown, version: unknown) => JSON.stringify({ name, version });

/** The legacy fixture, answering `ok` with the serverInfo its env gives. */
const legacy = (env: Record<string, string> = {}, extra: Partial<McplServerConfig> = {}, startLog?: string): McplServerConfig => ({
  id: 'legacy',
  command: process.execPath,
  args: [LEGACY, 'ok', ...(startLog ? [startLog] : [])],
  env,
  ...extra,
});

/** The hand-written modern fixture, with its flags. */
const raw = (flags: string, extra: Partial<McplServerConfig> = {}): McplServerConfig => ({
  id: 'raw',
  command: process.execPath,
  args: [RAW, flags, join(scratch(), 'wire.jsonl')],
  protocol: 'modern',
  ...extra,
});

async function connectLegacy(config: McplServerConfig): Promise<McplServerConnection> {
  const connection = await McplServerConnection.connectWithReconnect(config, HOST_CAPS);
  cleanups.push(() => connection.close().catch(() => {}));
  connection.on('error', () => {});
  connection.ready();
  return connection;
}

async function connectModern(config: McplServerConfig): Promise<ModernMcpConnection> {
  const connection = await ModernMcpConnection.connect(config);
  cleanups.push(() => connection.close().catch(() => {}));
  connection.on('error', () => {});
  return connection;
}

test("a legacy server's name and version come from its initialize answer", async () => {
  const connection = await connectLegacy(legacy({ SERVER_INFO: info('legacy-fixture', '2.1.0') }));
  assert.deepEqual(connection.serverInfo, { name: 'legacy-fixture', version: '2.1.0' });
});

test('a legacy server that gives no serverInfo has none', async () => {
  const connection = await connectLegacy(legacy());
  assert.equal(connection.serverInfo, null);
});

test('a part that is not text, or is empty, is null, and a serverInfo with neither part is none', async () => {
  const named = await connectLegacy(legacy({ SERVER_INFO: info('legacy-fixture', 5) }));
  assert.deepEqual(named.serverInfo, { name: 'legacy-fixture', version: null });
  const versioned = await connectLegacy(legacy({ SERVER_INFO: info(' \n ', '2.1.0') }));
  assert.deepEqual(versioned.serverInfo, { name: null, version: '2.1.0' });
  const empty = await connectLegacy(legacy({ SERVER_INFO: info('', '') }));
  assert.equal(empty.serverInfo, null);
});

test("a legacy server's name and version are its text: on one line, and with its credentials redacted", async () => {
  const connection = await connectLegacy(legacy({ API_TOKEN: TOKEN, SERVER_INFO: info('legacy\r\n\u2028fixture', `2.1.0+${TOKEN}`) }));
  assert.equal(connection.serverInfo?.name, 'legacy fixture');
  const version = connection.serverInfo?.version ?? '';
  assert.ok(version.startsWith('2.1.0+') && !version.includes(TOKEN), version);
});

test('a legacy reconnect replaces them with what the new launch says', async () => {
  const log = join(scratch(), 'starts.log');
  const connection = await connectLegacy(legacy({
    SERVER_INFO: info('legacy-fixture', '1.0.0'),
    SERVER_INFO_LATER: info('legacy-fixture', '1.1.0'),
  }, RECONNECT, log));
  assert.deepEqual(connection.serverInfo, { name: 'legacy-fixture', version: '1.0.0' });
  let reconnected = false;
  connection.on('reconnect', () => { reconnected = true; });
  await assert.rejects(connection.sendToolsCall('die', {}));
  await until(() => reconnected, 'a reconnect');
  assert.deepEqual(connection.serverInfo, { name: 'legacy-fixture', version: '1.1.0' });
});

test("a modern server's name and version come from its server/discover answer", async () => {
  const connection = await connectModern(raw(''));
  assert.deepEqual(connection.serverInfo, { name: 'raw-fixture', version: '1' });
});

test('a modern server that gives no serverInfo has none', async () => {
  const connection = await connectModern(raw('no-server-info'));
  assert.equal(connection.serverInfo, null);
});

test("a modern server's name and version are its text: on one line, and with its credentials redacted", async () => {
  const connection = await connectModern(raw('server-info-text', { env: { API_TOKEN: TOKEN } }));
  assert.equal(connection.serverInfo?.name, 'raw fixture');
  const version = connection.serverInfo?.version ?? '';
  assert.ok(version.startsWith('1 ') && !version.includes(TOKEN), version);
});

test('a modern reconnect replaces them with what the new launch says', async () => {
  const connection = await connectModern(raw('server-info-later', RECONNECT));
  assert.deepEqual(connection.serverInfo, { name: 'raw-fixture', version: '1' });
  let reconnected = false;
  connection.on('reconnect', () => { reconnected = true; });
  await connection.callTool('die', {}).catch(() => {});
  await until(() => reconnected, 'a reconnect');
  assert.deepEqual(connection.serverInfo, { name: 'raw-fixture', version: '2' });
});

test("each server's row lists what its handshake gave, an SDK server's included, and none where it gave nothing", async () => {
  const dir = scratch();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: { complete: async () => { throw new Error('not used'); } } as unknown as Membrane,
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
    mcplServers: [
      legacy({ SERVER_INFO: info('legacy-fixture', '2.1.0') }),
      { ...legacy(), id: 'anonymous' },
      { id: 'sdk', command: process.execPath, args: [SDK, join(dir, 'starts.log'), join(dir, 'events.log')], protocol: 'modern' },
    ],
  });
  cleanups.push(() => framework.stop());
  const rows = Object.fromEntries(framework.listMcplServers().map((row) => [row.id, row.serverInfo]));
  assert.deepEqual(rows, {
    legacy: { name: 'legacy-fixture', version: '2.1.0' },
    anonymous: null,
    sdk: { name: 'modern-fixture', version: '1.0.0' },
  });
});
