/**
 * Runtime MCPL server lifecycle — connectMcplServer / disconnectMcplServer /
 * restartMcplServer on a live framework, including lazy MCPL subsystem
 * initialization when the framework started with zero configured servers.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

import { AgentFramework } from '../src/index.js';
import { referenceRegistry } from '../src/mcpl/references.js';
import type { EventResponse, Module, ModuleContext, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** A module with no tools: only a name, for a server's tool prefix to collide with. */
class NamedModule implements Module {
  constructor(readonly name: string) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  async onProcess(): Promise<EventResponse> { return {}; }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: true }; }
}

// A tiny stdio MCPL server (same shape as mcpl-ws-transport.test.ts): reads
// NDJSON on stdin, answers initialize / tools/list / tools/call on stdout.
const STDIO_SERVER = `
let buf = '';
const answered = {};
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    // Requests a test's server never answers, named in SILENT_ON, and one it
    // answers a number of times and then never again (SILENT_AFTER=method:n).
    if ((process.env.SILENT_ON || '').split(',').includes(m.method)) continue;
    const [afterMethod, afterCount] = (process.env.SILENT_AFTER || ':').split(':');
    if (m.method === afterMethod) {
      answered[m.method] = (answered[m.method] || 0) + 1;
      if (answered[m.method] > Number(afterCount)) continue;
    }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.4', pushEvents: true } } } });
    else if (m.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] });
    else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: String((m.params && m.params.arguments && m.params.arguments.text) || '') }] });
    // Any other request is answered as unknown, so the host's wait for it ends
    // at once rather than at its timeout.
    else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } }) + '\\n');
  }
});
`;

/** The framework's inner disconnect, which a restart's own teardown calls
 *  (the public disconnectMcplServer is an operator operation around it). */
type Inner = { runDisconnectMcplServer(id: string): Promise<void> };
type Internals = {
  legacyConnectAborts(): Map<string, AbortController>;
  mcplServerRegistry: { getServer(id: string): { sendToolsList(): Promise<unknown> } | null } | null;
};

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(cond(), `in time: ${what}`);
}

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
    // Its address is recorded where a reference's stub reads it: none, for a
    // server the host spawns.
    assert.equal(referenceRegistry.serverAddress('dyn'), 'no-address');

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
    assert.ok(framework.getAllTools().some(tool => tool.name === 'mcpl--first--echo'));
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

test("restartMcplServer refuses what the connect would refuse before tearing anything down: another server's prefix or id, or a module's name", async () => {
  await withFramework(true, async (framework) => {
    await framework.connectMcplServer(serverConfig('second') as never);
    await framework.addModule(new NamedModule('notes'));
    const untouched = () => {
      const live = framework.listMcplServers().filter(s => s.connected).map(s => s.id).sort();
      assert.deepEqual(live, ['first', 'second'], 'both servers still connected');
      const tools = framework.getAllTools().map(t => t.name);
      assert.ok(tools.includes('mcpl--first--echo') && tools.includes('mcpl--second--echo'), 'and their tools still listed');
    };
    await assert.rejects(
      framework.restartMcplServer('first', serverConfig('first', { toolPrefix: 'mcpl--second' }) as never),
      /collides with server "second"/,
    );
    untouched();
    await assert.rejects(
      framework.restartMcplServer('first', serverConfig('first', { toolPrefix: 'notes' }) as never),
      /collides with module "notes"/,
    );
    untouched();
    // Under another live server's id, whose prefix is that server's own, so
    // only the id is taken.
    await assert.rejects(
      framework.restartMcplServer('first', serverConfig('second') as never),
      /MCPL server "second" is already registered/,
    );
    untouched();
  });
});

test('restartMcplServer under a new id may keep the tool prefix the restarted server frees', async () => {
  await withFramework(true, async (framework) => {
    await framework.restartMcplServer('first', serverConfig('renamed', { toolPrefix: 'mcpl--first' }) as never);
    const servers = framework.listMcplServers();
    assert.deepEqual(servers.map(s => [s.id, s.connected]), [['renamed', true]], 'first was replaced');
    assert.ok(framework.getAllTools().some(t => t.name === 'mcpl--first--echo'), 'and the prefix it freed serves the new id');
  });
});

test('restartMcplServer refuses once stop() has begun, before it disconnects anything', async (t) => {
  await withFramework(true, async (framework) => {
    const disconnect = t.mock.method(framework as unknown as Inner, 'runDisconnectMcplServer');
    const stopping = framework.stop();
    await assert.rejects(
      framework.restartMcplServer('first'),
      /restart MCPL server refused: the framework is stopping/,
    );
    await stopping;
    assert.equal(disconnect.mock.callCount(), 0, 'the restart disconnected nothing');
  });
});

test('restartMcplServer of an id whose disconnect is in flight is refused before it tears anything down', async (t) => {
  await withFramework(true, async (framework) => {
    const disconnecting = framework.disconnectMcplServer('first');
    const disconnect = t.mock.method(framework as unknown as Inner, 'runDisconnectMcplServer');
    await assert.rejects(
      framework.restartMcplServer('first'),
      /MCP server "first" was not restarted: it is being disconnected; restart it once that has finished/,
    );
    assert.equal(disconnect.mock.callCount(), 0, 'the restart started no disconnect of its own');
    disconnect.mock.restore();
    await disconnecting;
  });
});

test("a disconnect removes its server's prefix claim, and leaves one another server holds", async () => {
  await withFramework(true, async (framework) => {
    await framework.connectMcplServer(serverConfig('second', { toolPrefix: 'held' }) as never);
    await framework.disconnectMcplServer('first');
    // Its own claim is released: another server may take the prefix.
    await framework.connectMcplServer(serverConfig('third', { toolPrefix: 'mcpl--first' }) as never);
    // The other server's claim stands.
    await assert.rejects(
      framework.connectMcplServer(serverConfig('fourth', { toolPrefix: 'held' }) as never),
      /toolPrefix "held" collides with server "second"/,
    );
  });
});

test('a disconnect releases the prefix its server claimed at connect, though its configuration changed since', async () => {
  await withFramework(false, async (framework) => {
    const config = serverConfig('dyn', { toolPrefix: 'p1' });
    await framework.connectMcplServer(config as never);
    // Against the documented rule, the host changes the configuration it submitted.
    (config as unknown as { toolPrefix: string }).toolPrefix = 'p2';
    await framework.disconnectMcplServer('dyn');
    await framework.connectMcplServer(serverConfig('other', { toolPrefix: 'p1' }) as never);
    assert.deepEqual(framework.listMcplServers().map(s => s.id), ['other']);
  });
});

test('restartMcplServer of an id whose connect is in flight is refused before it tears anything down', async (t) => {
  // MCPL is up, so the connect holds its id before its first await.
  await withFramework(true, async (framework) => {
    const connecting = framework.connectMcplServer(serverConfig('later') as never);
    const disconnect = t.mock.method(framework as unknown as Inner, 'runDisconnectMcplServer');
    await assert.rejects(
      framework.restartMcplServer('later', serverConfig('renamed') as never),
      /MCP server "later" was not restarted: it is being connected; restart it once that has finished/,
    );
    assert.equal(disconnect.mock.callCount(), 0, 'the restart started no disconnect of its own');
    disconnect.mock.restore();
    await connecting;
  });
});

test('a connect started during a restart is refused the tool prefix the restart moves to, and the restart completes', async () => {
  await withFramework(true, async (framework) => {
    const restarting = framework.restartMcplServer('first', serverConfig('first', { toolPrefix: 'xx' }) as never);
    await assert.rejects(
      framework.connectMcplServer(serverConfig('third', { toolPrefix: 'xx' }) as never),
      /MCPL server "third" toolPrefix "xx" is held by the restart of "first"/,
    );
    await restarting;
    assert.deepEqual(framework.listMcplServers().map(s => [s.id, s.connected]), [['first', true]]);
    assert.ok(framework.getAllTools().some(t => t.name === 'xx--echo'), 'the restarted server serves the prefix');
  });
});

test('a connect started during a restart is refused the id the restart moves to, and the restart completes', async () => {
  await withFramework(true, async (framework) => {
    const restarting = framework.restartMcplServer('first', serverConfig('second') as never);
    // Another prefix, so only the id is contested.
    await assert.rejects(
      framework.connectMcplServer(serverConfig('second', { toolPrefix: 'other' }) as never),
      /MCP server "second" is held by the restart of "first"/,
    );
    await restarting;
    assert.deepEqual(framework.listMcplServers().map(s => [s.id, s.connected]), [['second', true]]);
    assert.ok(framework.getAllTools().some(t => t.name === 'mcpl--second--echo'));
  });
});

test("a connect between a restart's disconnect and its connect is refused the id the restart keeps", async (t) => {
  await withFramework(true, async (framework) => {
    const disconnect = (framework as unknown as Inner).runDisconnectMcplServer.bind(framework);
    let racing: Promise<unknown> | undefined;
    t.mock.method(framework as unknown as Inner, 'runDisconnectMcplServer', async (id: string) => {
      await disconnect(id);
      // The old server is gone and its disconnect holds nothing now.
      racing = framework.connectMcplServer(serverConfig('first', { toolPrefix: 'other' }) as never)
        .then(() => 'connected', (error: unknown) => error);
    });
    await framework.restartMcplServer('first');
    const outcome = await racing;
    assert.ok(outcome instanceof Error, `the racing connect was refused, not ${String(outcome)}`);
    assert.match(outcome.message, /MCP server "first" is held by the restart of "first"/);
    assert.deepEqual(framework.listMcplServers().map(s => [s.id, s.connected]), [['first', true]]);
    assert.ok(framework.getAllTools().some(tool => tool.name === 'mcpl--first--echo'));
  });
});

test('a restart of an id another restart holds is refused before it tears anything down', async (t) => {
  await withFramework(true, async (framework) => {
    await framework.connectMcplServer(serverConfig('second') as never);
    const disconnect = (framework as unknown as Inner).runDisconnectMcplServer.bind(framework);
    let during: (() => Promise<void>) | undefined;
    const refusals: string[] = [];
    t.mock.method(framework as unknown as Inner, 'runDisconnectMcplServer', async (id: string) => {
      await disconnect(id);
      // Between the restart's disconnect and its connect, only its claims hold these ids.
      const attempt = during;
      during = undefined;
      if (attempt) {
        await attempt().then(() => refusals.push('restarted'), (error: unknown) => refusals.push((error as Error).message));
      }
    });
    // A restart under the same id holds it.
    during = () => framework.restartMcplServer('first', serverConfig('first') as never);
    await framework.restartMcplServer('first');
    // A restart under a new id holds the new one.
    during = () => framework.restartMcplServer('renamed', serverConfig('renamed') as never);
    await framework.restartMcplServer('second', serverConfig('renamed') as never);
    assert.deepEqual(refusals, [
      'MCP server "first" was not restarted: it is being restarted; restart it once that has finished',
      'MCP server "renamed" was not restarted: the restart of "second" holds its id; restart it once that has finished',
    ]);
    assert.deepEqual(framework.listMcplServers().map(s => [s.id, s.connected]).sort(), [['first', true], ['renamed', true]]);
  });
});

test('a module is refused a name a server holds as its tool prefix, or a restart is moving its server to', async () => {
  await withFramework(true, async (framework) => {
    await assert.rejects(
      framework.addModule(new NamedModule('mcpl--first')),
      /Module "mcpl--first" collides with MCPL server "first"'s toolPrefix "mcpl--first"/,
    );
    const restarting = framework.restartMcplServer('first', serverConfig('first', { toolPrefix: 'xx' }) as never);
    await assert.rejects(
      framework.addModule(new NamedModule('xx')),
      /Module "xx" collides with the toolPrefix "xx" the restart of "first" holds/,
    );
    await restarting;
    assert.deepEqual(framework.listMcplServers().map(s => [s.id, s.connected]), [['first', true]]);
    assert.ok(framework.getAllTools().some(t => t.name === 'xx--echo'), 'the restarted server serves the prefix');
  });
});

test('a restart that fails releases the id and the tool prefix it held', async (t) => {
  await withFramework(true, async (framework) => {
    t.mock.method(framework as unknown as Inner, 'runDisconnectMcplServer', async () => {
      throw new Error('disconnect failed for the test');
    });
    await assert.rejects(
      framework.restartMcplServer('first', serverConfig('renamed', { toolPrefix: 'xx' }) as never),
      /disconnect failed for the test/,
    );
    t.mock.restoreAll();
    await framework.connectMcplServer(serverConfig('renamed', { toolPrefix: 'xx' }) as never);
    assert.deepEqual(
      framework.listMcplServers().map(s => [s.id, s.connected]).sort(),
      [['first', true], ['renamed', true]],
    );
  });
});

test('a restart moving to an id or a tool prefix another restart holds is refused before it tears anything down', async (t) => {
  await withFramework(true, async (framework) => {
    await framework.connectMcplServer(serverConfig('second') as never);
    const disconnect = (framework as unknown as Inner).runDisconnectMcplServer.bind(framework);
    const refusals: string[] = [];
    t.mock.method(framework as unknown as Inner, 'runDisconnectMcplServer', async (id: string) => {
      await disconnect(id);
      if (id !== 'first') return;
      // Between first's disconnect and its connect, only its claims hold "moved" and "xx".
      for (const attempt of [
        () => framework.restartMcplServer('second', serverConfig('moved', { toolPrefix: 'other' }) as never),
        () => framework.restartMcplServer('second', serverConfig('second', { toolPrefix: 'xx' }) as never),
      ]) {
        await attempt().then(() => refusals.push('restarted'), (error: unknown) => refusals.push((error as Error).message));
      }
    });
    await framework.restartMcplServer('first', serverConfig('moved', { toolPrefix: 'xx' }) as never);
    assert.deepEqual(refusals, [
      'MCP server "second" was not restarted: MCP server "moved" is held by the restart of "first"; restart "second" once that has finished',
      'MCPL server "second" toolPrefix "xx" is held by the restart of "first"',
    ]);
    assert.deepEqual(framework.listMcplServers().map(s => [s.id, s.connected]).sort(), [['moved', true], ['second', true]]);
    const tools = framework.getAllTools().map(tool => tool.name);
    assert.ok(tools.includes('xx--echo') && tools.includes('mcpl--second--echo'), 'each serves its own prefix');
  });
});

test('a restart whose connect fails leaves the server down, configured and not connected, and releases its holds', async () => {
  await withFramework(true, async (framework) => {
    const exits = { id: 'renamed', command: process.execPath, args: ['-e', 'process.exit(3)'], toolPrefix: 'xx' };
    await assert.rejects(
      framework.restartMcplServer('first', exits as never),
      /^Error: MCP server "first" is down: it was disconnected for its restart, and the restart's connect failed: /,
    );
    // As any failed connect leaves its server: listed as not connected, holding its prefix.
    assert.deepEqual(framework.listMcplServers().map(s => [s.id, s.connected]), [['renamed', false]]);
    await assert.rejects(
      framework.addModule(new NamedModule('xx')),
      /Module "xx" collides with MCPL server "renamed"'s toolPrefix "xx"/,
    );
    // The restart's holds are released, so the id and the prefix take a working configuration.
    await framework.restartMcplServer('renamed', serverConfig('renamed', { toolPrefix: 'xx' }) as never);
    assert.deepEqual(framework.listMcplServers().map(s => [s.id, s.connected]), [['renamed', true]]);
    assert.ok(framework.getAllTools().some(tool => tool.name === 'xx--echo'));
  });
});

for (const when of ['teardown', 'gap', 'connect'] as const) {
  test(`a disconnect that begins during a restart's ${when} ends it: the server stays disconnected and the holds are released`, async (t) => {
    await withFramework(true, async (framework) => {
      const disconnect = (framework as unknown as Inner).runDisconnectMcplServer.bind(framework);
      let host: Promise<unknown> | undefined;
      // The host's disconnect, an operator operation of its own.
      const hostDisconnect = () => {
        host = framework.disconnectMcplServer('first').then(() => 'disconnected', (error: unknown) => error);
      };
      let restarts = true;
      t.mock.method(framework as unknown as Inner, 'runDisconnectMcplServer', async (id: string) => {
        // The host's disconnect goes through as it is.
        if (!restarts) return disconnect(id);
        restarts = false;
        // The restart's own disconnect.
        const own = disconnect(id);
        if (when === 'teardown') hostDisconnect();
        await own;
        if (when === 'gap') hostDisconnect();
        // The restart's connect takes the id within this turn, before an immediate runs.
        if (when === 'connect') setImmediate(hostDisconnect);
      });
      const refused = await framework.restartMcplServer('first').then(() => null, (error: unknown) => error as Error);
      assert.match(refused?.message ?? 'restarted', /^MCP server "first" is down: it was disconnected for its restart, and the restart's connect failed: /);
      if (when !== 'connect') {
        // Its connect is refused at once, naming the disconnect.
        assert.match(refused!.message, /: MCP server "first" is being disconnected, which ends the restart of "first"$/);
      } else {
        // Its connect, under way, is ended by the disconnect, in whichever
        // phase the disconnect finds it.
        assert.match(refused!.message, /: MCP server "first" (was not connected: it was disconnected (while connecting|or lost while its tools were being listed)|is being disconnected, which ends the restart of "first")$/);
      }
      assert.equal(await host, 'disconnected', 'the disconnect completed');
      assert.deepEqual(framework.listMcplServers(), [], 'nothing is left of the server');
      t.mock.restoreAll();
      // Nothing holds the id or its prefix now.
      await framework.connectMcplServer(serverConfig('first') as never);
      assert.deepEqual(framework.listMcplServers().map(s => [s.id, s.connected]), [['first', true]]);
    });
  });
}

test("a stop() that begins in a restart's gap ends it, and the restart says the server is down", async (t) => {
  await withFramework(true, async (framework) => {
    const disconnect = (framework as unknown as Inner).runDisconnectMcplServer.bind(framework);
    let stopping: Promise<void> | undefined;
    t.mock.method(framework as unknown as Inner, 'runDisconnectMcplServer', async (id: string) => {
      await disconnect(id);
      stopping = framework.stop();
    });
    await assert.rejects(
      framework.restartMcplServer('first'),
      /^Error: MCP server "first" is down: it was disconnected for its restart, and the restart's connect failed: MCP server "first" was not connected: the framework is stopping or stopped$/,
    );
    await stopping;
  });
});

test("a disconnect of the id a restart moves to ends the restart, even one that finishes before the restart's connect", async (t) => {
  await withFramework(true, async (framework) => {
    const disconnect = (framework as unknown as Inner).runDisconnectMcplServer.bind(framework);
    t.mock.method(framework as unknown as Inner, 'runDisconnectMcplServer', async (id: string) => {
      await disconnect(id);
      // In the restart's gap, the id it moves to is disconnected, and that
      // disconnect is over before the restart's connect begins.
      if (id === 'first') await framework.disconnectMcplServer('second');
    });
    await assert.rejects(
      framework.restartMcplServer('first', serverConfig('second') as never),
      /^Error: MCP server "first" is down: it was disconnected for its restart, and the restart's connect failed: MCP server "second" was disconnected, which ends the restart of "first"$/,
    );
    assert.deepEqual(framework.listMcplServers(), [], 'nothing was connected under the new id');
    assert.ok(!framework.getAllTools().some(tool => tool.name.startsWith('mcpl--second--')));
    // The id and the prefix are free again.
    await framework.connectMcplServer(serverConfig('second') as never);
    assert.deepEqual(framework.listMcplServers().map(s => [s.id, s.connected]), [['second', true]]);
  });
});

/** A stdio server that reads its input and never answers, so a connect waits in its handshake. */
const SILENT = { id: 'silent', command: process.execPath, args: ['-e', 'process.stdin.resume()'] };

for (const ending of ['stop()', 'a disconnect'] as const) {
  test(`${ending} ends a legacy connect stuck in its handshake at once`, async () => {
    await withFramework(true, async (framework) => {
      const connecting = framework.connectMcplServer(SILENT as never).then(() => null, (error: unknown) => error as Error);
      // The connect is in its handshake, which never finishes.
      await until(() => (framework as unknown as Internals).legacyConnectAborts().has('silent'), 'the connect in its handshake');
      const started = Date.now();
      if (ending === 'stop()') await framework.stop();
      else await framework.disconnectMcplServer('silent');
      const took = Date.now() - started;
      assert.ok(took < 10_000, `${ending} took ${took} ms, as if it waited out the handshake`);
      const refused = await connecting;
      assert.match(refused?.message ?? 'connected', ending === 'stop()'
        ? /^MCP server "silent" was not connected: the framework stopped while it was connecting$/
        : /^MCP server "silent" was not connected: it was disconnected while connecting$/);
      if (ending === 'a disconnect') assert.ok(!framework.listMcplServers().some(s => s.id === 'silent'), 'nothing is left of it');
    });
  });
}

for (const silentOn of ['featureSets/update', 'tools/list'] as const) {
  test(`stop() ends a legacy connect past its handshake whose server never answers ${silentOn}, with no request timeout`, async () => {
    await withFramework(true, async (framework) => {
      const config = serverConfig('late', { env: { SILENT_ON: silentOn }, requestTimeoutMs: 0 });
      const connecting = framework.connectMcplServer(config as never).then(() => null, (error: unknown) => error as Error);
      // Past the handshake, registered, waiting for the answer that never comes.
      await until(() => !!(framework as unknown as Internals).mcplServerRegistry?.getServer('late'), 'the connect past its handshake');
      const started = Date.now();
      await framework.stop();
      const took = Date.now() - started;
      assert.ok(took < 10_000, `stop() took ${took} ms, as if it waited on the server`);
      const refused = await connecting;
      assert.match(refused?.message ?? 'connected', /^MCP server "late" was not connected: the framework stopped while it was connecting$/);
    });
  });
}

test("stop() ends a connect whose tool listing waits on another server that stopped answering", async () => {
  await withFramework(false, async (framework) => {
    // Lists its tools once, at its own connect, and never again.
    await framework.connectMcplServer(serverConfig('quiet', { env: { SILENT_AFTER: 'tools/list:1' }, requestTimeoutMs: 0 }) as never);
    const quiet = (framework as unknown as Internals).mcplServerRegistry!.getServer('quiet')!;
    const realList = quiet.sendToolsList.bind(quiet);
    let asked = false;
    quiet.sendToolsList = () => { asked = true; return realList(); };
    const connecting = framework.connectMcplServer(serverConfig('late') as never).then(() => null, (error: unknown) => error as Error);
    // The new connect is listing every server's tools, and waits on "quiet".
    await until(() => asked, "the new connect's listing asked quiet");
    const started = Date.now();
    await framework.stop();
    const took = Date.now() - started;
    assert.ok(took < 10_000, `stop() took ${took} ms, as if it waited on the other server`);
    const refused = await connecting;
    assert.match(refused?.message ?? 'connected', /^MCP server "late" was not connected: the framework stopped while it was connecting$/);
  });
});

test("stop() ends a WebSocket dial still waiting for its access provider", async () => {
  await withFramework(true, async (framework) => {
    let asked = false;
    const waiting = {
      id: 'dial',
      url: 'ws://127.0.0.1:9/mcp',
      // A provider that never settles.
      accessProvider: () => { asked = true; return new Promise<string>(() => {}); },
    };
    const connecting = framework.connectMcplServer(waiting as never).then(() => null, (error: unknown) => error as Error);
    for (let i = 0; i < 50 && !asked; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(asked, 'the dial is waiting for its provider');
    const started = Date.now();
    await framework.stop();
    assert.ok(Date.now() - started < 10_000, 'stop() did not wait for the provider');
    const refused = await connecting;
    assert.match(refused?.message ?? 'connected', /^MCP server "dial" was not connected: the framework stopped while it was connecting$/);
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

test('create() refuses a boolean setting that holds anything but true or false, before it spawns any server', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mcpl-lifecycle-'));
  const marker = join(tempDir, 'spawned');
  // A valid server listed first writes a marker when it starts, so a refusal
  // that came after anything was spawned leaves the marker. Both servers
  // exit as soon as they start, so a spawn that shouldn't have happened
  // leaves no child holding the test open.
  const early = { id: 'early', command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`] };
  const refused = (extra: Record<string, unknown>) => ({ id: 'quoted', command: process.execPath, args: ['-e', ''], ...extra });
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['inheritEnv', { inheritEnv: 'false' }, 'true or false, unquoted, not a string'],
    ['reconnect', { reconnect: 'true' }, 'true or false, unquoted, not a string'],
    ['allowHostCommands', { allowHostCommands: 1 }, 'true or false, not a number'],
  ];
  try {
    for (const [setting, extra, wanted] of cases) {
      const created = AgentFramework.create({
        storePath: join(tempDir, `test-${setting}.chronicle`),
        membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
        modules: [],
        mcplServers: [early, refused(extra)] as never,
      });
      // A framework created anyway is stopped, so the failure is this
      // assertion rather than a file held open by its server.
      await assert.rejects(
        created.then(async (framework) => { await framework.stop(); return framework; }),
        new RegExp(`MCPL server "quoted" ${setting} must be ${wanted}: `),
      );
      assert.equal(existsSync(marker), false, `no server was spawned before ${setting} was refused`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('connectMcplServer refuses a boolean setting that holds anything but true or false, and registers nothing', async () => {
  await withFramework(true, async (framework) => {
    for (const [setting, value] of [['inheritEnv', 'false'], ['reconnect', 'false'], ['allowHostCommands', 'true']]) {
      await assert.rejects(
        framework.connectMcplServer(serverConfig('second', { [setting]: value }) as never),
        new RegExp(`MCPL server "second" ${setting} must be true or false, unquoted, not a string: `),
      );
    }
    assert.deepEqual(framework.listMcplServers().map(s => s.id), ['first']);
  });
});

test('restartMcplServer refuses such a setting before it disconnects the running server, which stays up', async () => {
  await withFramework(true, async (framework) => {
    for (const [setting, value] of [['inheritEnv', 'true'], ['reconnect', 'true'], ['allowHostCommands', 'false']]) {
      await assert.rejects(
        framework.restartMcplServer('first', serverConfig('first', { [setting]: value }) as never),
        new RegExp(`MCPL server "first" ${setting} must be true or false, unquoted, not a string: `),
      );
      const servers = framework.listMcplServers();
      assert.equal(servers.length, 1);
      assert.equal(servers[0].connected, true, `the running server stays connected after ${setting} was refused`);
    }
  });
});

test('restartMcplServer given no config checks the stored one, before it disconnects the running server', async () => {
  await withFramework(false, async (framework) => {
    const config: Record<string, unknown> = serverConfig('stored');
    await framework.connectMcplServer(config as never);
    // The framework keeps the caller's own config object, so a host that
    // changes it in place changes what a restart with no new config uses.
    config.reconnect = 'true';
    await assert.rejects(
      framework.restartMcplServer('stored'),
      /MCPL server "stored" reconnect must be true or false, unquoted, not a string: /,
    );
    assert.deepEqual(
      framework.listMcplServers().map((s) => [s.id, s.connected]),
      [['stored', true]],
      'the running server stays connected',
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
      if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5', pushEvents: true } } } });
      else if (msg.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] });
      else if (msg.method === 'featureSets/update') reply({ accepted: true });
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
