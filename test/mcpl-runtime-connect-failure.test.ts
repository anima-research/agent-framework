/**
 * A runtime connect or restart whose §5.3 policy registration throws closes
 * its new connection for good, through the registry, while its exchange's
 * marker still holds its planes: left live, it would be half registered. A
 * close that then fails keeps the entry, so a later disconnect, restart or
 * shutdown can close it again, and a connection closed for good readies
 * nothing, so what it held stays held through any later open of every plane.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/reregistering-mcpl-server.mjs', import.meta.url));

describe('MCPL runtime connect: a policy registration that throws', () => {
  let dir: string;
  let framework: AgentFramework | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcpl-runtime-connect-failure-'));
  });

  afterEach(async () => {
    await framework?.stop();
    framework = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function serverConfig(id: string) {
    return {
      id,
      command: process.execPath,
      args: [FIXTURE],
      env: { EVENTS_PATH: join(dir, `${id}-events.jsonl`), ROLE: id },
      enabledFeatureSets: ['chat'],
      requestTimeoutMs: 1_000,
    };
  }

  /**
   * A framework serving `running`, then a runtime connect of `chat` whose §5.3
   * policy registration throws (initializeServer made to throw for it). With
   * `closeFails`, the close that follows fails once in its transport close,
   * after close() has marked the connection closed for good, as a real one
   * fails. Every patch is undone before it returns.
   */
  async function failPolicyRegistration(closeFails: boolean) {
    const chat = serverConfig('chat');
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [],
      maintenanceIntervalMs: 0,
      mcplServers: [serverConfig('running')],
    });
    // Which servers' tools the framework asks to relist.
    const lists = framework as unknown as { handleToolsListChanged(id: string): void };
    const relist = lists.handleToolsListChanged.bind(framework);
    const refreshed: string[] = [];
    lists.handleToolsListChanged = (id: string) => { refreshed.push(id); relist(id); };
    const features = FeatureSetManager.prototype as any;
    const initializeServer = features.initializeServer;
    features.initializeServer = function (this: unknown, serverId: string, ...rest: unknown[]) {
      if (serverId === chat.id) throw new Error('injected policy registration failure');
      return initializeServer.call(this, serverId, ...rest);
    };
    const openEvery = (framework as unknown as { readyMcplPlanes(): void }).readyMcplPlanes.bind(framework);
    const deliveredAtClose: string[] = [];
    let opened = false;
    const connections = McplServerConnection.prototype as any;
    const close = connections.close;
    let closeFailed = false;
    connections.close = function (this: any) {
      if (this.id === chat.id && !opened) {
        opened = true;
        this.on('held-data', () => deliveredAtClose.push('data'));
        this.emit('held-data', {});
        openEvery();
      }
      if (closeFails && this.id === chat.id && !closeFailed && this.transport) {
        closeFailed = true;
        const transport = this.transport;
        const transportClose = transport.close;
        transport.close = () => {
          transport.close = transportClose;
          return Promise.reject(new Error('injected close failure'));
        };
      }
      return close.call(this);
    };
    try {
      // The connect reports its own failure, not the close's.
      await assert.rejects(framework.connectMcplServer(chat), /injected policy registration failure/);
    } finally {
      features.initializeServer = initializeServer;
      connections.close = close;
    }
    assert.equal(closeFailed, closeFails, 'the close failed only when asked to');
    assert.ok(opened, 'its close began');
    assert.deepEqual(deliveredAtClose, [], 'an open of every connection as its close began let out nothing it held');
    const registry = (framework as unknown as { mcplServerRegistry: { getServer(id: string): unknown } }).mcplServerRegistry;
    const running = registry.getServer('running') as { dataPlaneReady: boolean };
    assert.equal(framework.listMcplServers().find((server) => server.id === 'running')?.connected, true, 'the running server stays connected');
    assert.equal(running.dataPlaneReady, true, 'the running server\'s data flows');
    return { chat, registry, refreshed };
  }

  it('closes its connection for good, so a later connect of its id reaches the server', async () => {
    const { chat } = await failPolicyRegistration(false);
    await framework!.connectMcplServer(chat);
    assert.equal(framework!.listMcplServers().find((server) => server.id === chat.id)?.connected, true);
  });

  it('keeps a connection whose close then fails registered and paused through a resume, and logs the close', async (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const { chat, registry, refreshed } = await failPolicyRegistration(true);
    // A close that fails keeps the entry, so a later disconnect, restart or
    // shutdown can close it again.
    const refused = registry.getServer(chat.id) as { dataPlaneReady: boolean; willReconnect: boolean } | null;
    assert.ok(refused, 'the connection whose close failed is still registered');
    assert.equal(refused.willReconnect, false, 'its close had disarmed it before the transport close failed');
    assert.equal(refused.dataPlaneReady, false, 'the failed connect left it paused');
    assert.ok(refreshed.includes(chat.id), 'a refresh of the tool list was asked for though its close failed');
    // A resume opens every registered server's planes.
    await framework!.quiesce({ reason: 'test' });
    await framework!.resume();
    assert.equal(refused.dataPlaneReady, false, 'a resume leaves it paused');
    assert.ok(
      logged.some((line) => line.includes(`could not close MCPL server "${chat.id}" after its policy registration failed`)
        && line.includes('injected close failure')),
      'the failed close was logged',
    );
  });
});

describe('MCPL: a connection closed for good', () => {
  it('readies nothing, so what it held stays held, while a running connection lets out what it held', async () => {
    const running = Reflect.construct(McplServerConnection, ['running', null, null]) as McplServerConnection;
    const closing = Reflect.construct(McplServerConnection, ['closing', null, null]) as McplServerConnection;
    const delivered: string[] = [];
    for (const connection of [running, closing]) {
      connection.on('stderr', () => delivered.push(`${connection.id} control`));
      connection.on('held-data', () => delivered.push(`${connection.id} data`));
      // Both planes start closed, so each holds a control event and a data event.
      connection.emit('stderr', 'a line');
      connection.emit('held-data', {});
    }
    assert.deepEqual(delivered, []);

    // close() closes the connection for good as it starts, so its close is
    // still under way here.
    const closed = closing.close();
    for (const connection of [running, closing]) connection.readyControlPlane();
    assert.deepEqual(delivered, ['running control'], 'only the running connection lets out its control traffic');
    for (const connection of [running, closing]) connection.ready();
    assert.deepEqual(delivered, ['running control', 'running data'], 'and only it lets out its data');
    await closed;
  });
});
