/**
 * Runtime MCPL server lifecycle — connectMcplServer / disconnectMcplServer /
 * restartMcplServer on a live framework, including lazy MCPL subsystem
 * initialization when the framework started with zero configured servers.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

// A tiny stdio MCPL server (same shape as mcpl-ws-transport.test.ts): reads
// NDJSON on stdin, answers initialize / tools/list / tools/call on stdout.
const STDIO_SERVER = `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.4', pushEvents: true } } } });
    else if (m.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] });
    else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: String((m.params && m.params.arguments && m.params.arguments.text) || '') }] });
  }
});
`;

function serverConfig(id: string, extra?: Record<string, unknown>) {
  return { id, command: process.execPath, args: ['-e', STDIO_SERVER], ...extra };
}

async function withFramework(
  withServer: boolean,
  fn: (framework: AgentFramework) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'mcpl-lifecycle-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
    ...(withServer ? { mcplServers: [serverConfig('first')] } : {}),
  });
  try {
    await fn(framework);
  } finally {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('connectMcplServer lazily initializes MCPL on a zero-server framework and exposes tools', async () => {
  await withFramework(false, async (framework) => {
    assert.deepEqual(framework.listMcplServers(), [], 'no servers configured at start');

    await framework.connectMcplServer(serverConfig('dyn'));

    const servers = framework.listMcplServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0].id, 'dyn');
    assert.equal(servers[0].connected, true);
    assert.equal(servers[0].toolCount, 1);

    const toolNames = framework.getAllTools().map(t => t.name);
    assert.ok(toolNames.includes('mcpl--dyn--echo'), `expected mcpl--dyn--echo in ${toolNames}`);
  });
});

test('disconnectMcplServer removes the server and its tools', async () => {
  await withFramework(true, async (framework) => {
    assert.ok(
      framework.getAllTools().some(t => t.name === 'mcpl--first--echo'),
      'startup server tools present',
    );

    await framework.disconnectMcplServer('first');

    assert.deepEqual(framework.listMcplServers(), [], 'server gone from list');
    assert.ok(
      !framework.getAllTools().some(t => t.name.startsWith('mcpl--first--')),
      'tools removed after disconnect',
    );
  });
});

test('restartMcplServer respawns the server and keeps tools available', async () => {
  await withFramework(true, async (framework) => {
    await framework.restartMcplServer('first');

    const servers = framework.listMcplServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0].connected, true);
    assert.equal(servers[0].toolCount, 1);
    assert.ok(framework.getAllTools().some(t => t.name === 'mcpl--first--echo'));
  });
});

test('restartMcplServer accepts an updated config (new toolPrefix)', async () => {
  await withFramework(true, async (framework) => {
    await framework.restartMcplServer('first', serverConfig('first', { toolPrefix: 'renamed' }) as never);

    const toolNames = framework.getAllTools().map(t => t.name);
    assert.ok(toolNames.includes('renamed--echo'), `expected renamed--echo in ${toolNames}`);
    assert.ok(!toolNames.some(n => n.startsWith('mcpl--first--')), 'old prefix gone');
  });
});

test('connectMcplServer rejects a duplicate id and a colliding prefix', async () => {
  await withFramework(true, async (framework) => {
    await assert.rejects(
      framework.connectMcplServer(serverConfig('first')),
      /already registered/,
    );

    await assert.rejects(
      framework.connectMcplServer(serverConfig('second', { toolPrefix: 'mcpl--first' })),
      /collides with server "first"/,
    );
  });
});

test('connectMcplServer hot-connects a network-only (WebSocket) MCPL server', async () => {
  // Minimal in-process MCPL server over WebSocket (same shape as
  // mcpl-ws-transport.test.ts) — no child process involved.
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg: { id?: unknown; method?: string; params?: { arguments?: Record<string, unknown> } };
      try { msg = JSON.parse(String(data)); } catch { return; }
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.4', pushEvents: true } } } });
      else if (msg.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] });
    });
  });
  await new Promise<void>((resolve) => (wss.address() ? resolve() : wss.once('listening', () => resolve())));
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/mcpl`;

  try {
    await withFramework(false, async (framework) => {
      await framework.connectMcplServer({ id: 'netsrv', url } as never);

      const servers = framework.listMcplServers();
      assert.equal(servers.length, 1);
      assert.equal(servers[0].connected, true);
      assert.equal(servers[0].url, url);
      assert.ok(framework.getAllTools().some(t => t.name === 'mcpl--netsrv--echo'));

      await framework.disconnectMcplServer('netsrv');
      assert.ok(!framework.getAllTools().some(t => t.name.startsWith('mcpl--netsrv--')));
    });
  } finally {
    wss.close();
  }
});

test('disconnecting an unknown server is a no-op (routing state cleared, no throw)', async () => {
  await withFramework(true, async (framework) => {
    await framework.disconnectMcplServer('nope');
    assert.equal(framework.listMcplServers().length, 1, 'existing server untouched');
  });
});
