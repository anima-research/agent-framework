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
import type { McpServerInfo } from '../src/index.js';
import { NOTICE_TAG } from '../src/notice-tags.js';

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

const info = (name: unknown, version: unknown) => ({ name, version });

const legacy = (serverInfo: unknown = null, extra: Partial<McplServerConfig> = {}, startLog?: string): McplServerConfig => ({
  id: 'legacy',
  command: process.execPath,
  args: [LEGACY, 'ok', ...(startLog ? [startLog] : [])],
  ...extra,
  env: { ...(serverInfo === null ? {} : { SERVER_INFO: JSON.stringify(serverInfo) }), ...extra.env },
});

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

async function serverInfoAtReconnect(
  connection: { on(event: 'reconnect', listener: () => void): unknown; serverInfo: McpServerInfo | null },
  die: () => Promise<unknown>,
): Promise<McpServerInfo | null> {
  const seen: Array<McpServerInfo | null> = [];
  connection.on('reconnect', () => { if (seen.length === 0) seen.push(connection.serverInfo); });
  await die().catch(() => {});
  await until(() => seen.length > 0, 'a reconnect');
  return seen[0] ?? null;
}

test("a legacy server's name and version come from its initialize answer", async () => {
  const connection = await connectLegacy(legacy(info('legacy-fixture', '2.1.0')));
  assert.deepEqual(connection.serverInfo, { name: 'legacy-fixture', version: '2.1.0' });
});

test('a legacy server that gives no serverInfo has none', async () => {
  const connection = await connectLegacy(legacy());
  assert.equal(connection.serverInfo, null);
});

test('a part that is not text, or is empty, is null, and a serverInfo with neither part is none', async () => {
  const named = await connectLegacy(legacy(info('legacy-fixture', 5)));
  assert.deepEqual(named.serverInfo, { name: 'legacy-fixture', version: null });
  const versioned = await connectLegacy(legacy(info(' \n ', '2.1.0')));
  assert.deepEqual(versioned.serverInfo, { name: null, version: '2.1.0' });
  const empty = await connectLegacy(legacy(info('', '')));
  assert.equal(empty.serverInfo, null);
});

test("a legacy server's name and version are its text: on one line, with its credentials redacted and a notice opening marked", async () => {
  const opening = `[${NOTICE_TAG.withheld}:`;
  const connection = await connectLegacy(legacy(info(`legacy\r\n\u2028fixture ${opening} x]`, `2.1.0+${TOKEN}`), { env: { API_TOKEN: TOKEN } }));
  const name = connection.serverInfo?.name ?? '';
  assert.ok(name.startsWith('legacy fixture ') && name.includes(`\\${opening}`), name);
  const version = connection.serverInfo?.version ?? '';
  assert.ok(version.startsWith('2.1.0+') && !version.includes(TOKEN), version);
});

test('each legacy reconnect replaces them with what the new launch says, before its reconnect is emitted', async () => {
  const log = join(scratch(), 'starts.log');
  const connection = await connectLegacy(legacy([info('legacy-fixture', '1.0.0'), info('legacy-fixture', '1.1.0'), null], RECONNECT, log));
  assert.deepEqual(connection.serverInfo, { name: 'legacy-fixture', version: '1.0.0' });
  assert.deepEqual(await serverInfoAtReconnect(connection, () => connection.sendToolsCall('die', {})), { name: 'legacy-fixture', version: '1.1.0' });
  connection.ready();
  assert.equal(await serverInfoAtReconnect(connection, () => connection.sendToolsCall('die', {})), null);
  assert.equal(connection.serverInfo, null);
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

test('each modern reconnect replaces them with what the new launch says, before its reconnect is emitted', async () => {
  const connection = await connectModern(raw('server-info-later', RECONNECT));
  assert.deepEqual(connection.serverInfo, { name: 'raw-fixture', version: '1' });
  assert.deepEqual(await serverInfoAtReconnect(connection, () => connection.callTool('die', {})), { name: 'raw-fixture', version: '2' });
  assert.equal(await serverInfoAtReconnect(connection, () => connection.callTool('die', {})), null);
  assert.equal(connection.serverInfo, null);
});

test("each server's row lists what its handshake gave, an SDK server's included, and none where it gave nothing", async () => {
  const dir = scratch();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: { complete: async () => { throw new Error('not used'); } } as unknown as Membrane,
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
    mcplServers: [
      legacy(info('legacy-fixture', '2.1.0')),
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
  const again = framework.listMcplServers().find((row) => row.id === 'legacy');
  assert.notStrictEqual(again?.serverInfo, rows.legacy, 'each listing gives its own copy');
});
