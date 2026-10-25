import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Module } from '../src/types/index.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { startScriptedServer, makeFramework, waitFor, type Json } from './helpers/toolset-servers.js';

const ADVERT: Json = {
  toolHints: true,
  featureSets: { 'arc.tools': { description: 'tools', uses: ['tools'] } },
};
const STATUS: Json = { name: 'status', description: 'Status of the arcade.', inputSchema: { type: 'object', properties: {} } };

async function heldAtModuleAdd() {
  const fw = await makeFramework([]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let adding = false;
  const addModule = fw.framework.addModule.bind(fw.framework);
  fw.framework.addModule = async (module: Module) => { adding = true; await held; return addModule(module); };
  return { fw, release, adding: () => adding };
}

test('a disconnect while a toolHints server is still connecting ends the connect before it dials the server', async () => {
  const server = await startScriptedServer({ advert: ADVERT, tools: [STATUS] });
  const { fw, release, adding } = await heldAtModuleAdd();
  try {
    const config: McplServerConfig = { id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true };
    const connect = fw.framework.connectMcplServer(config);
    connect.catch(() => undefined);
    await waitFor(adding, 'the toolsets module being added');
    const disconnect = fw.framework.disconnectMcplServer('arc');
    release();
    await assert.rejects(connect, /"arc" was not connected: it was disconnected while connecting/);
    await disconnect;
    assert.equal(server.peers.length, 0, 'nothing dialed the server');
  } finally {
    await fw.stop();
    await server.close();
  }
});

test('a stop while a toolHints server is still connecting ends the connect, which says the framework stopped', async () => {
  const server = await startScriptedServer({ advert: ADVERT, tools: [STATUS] });
  const { fw, release, adding } = await heldAtModuleAdd();
  try {
    const config: McplServerConfig = { id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true };
    const connect = fw.framework.connectMcplServer(config);
    connect.catch(() => undefined);
    await waitFor(adding, 'the toolsets module being added');
    const stopped = fw.framework.stop();
    release();
    await assert.rejects(connect, /"arc" was not connected: the framework stopped while it was connecting/);
    await stopped;
    assert.equal(server.peers.length, 0, 'nothing dialed the server');
  } finally {
    await fw.stop();
    await server.close();
  }
});
