import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentFramework } from '../src/framework.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';

function frameworkWithConnection(connection: Record<string, unknown>) {
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplServerConfigs = new Map([[
    'discord',
    { id: 'discord', command: 'node', allowHostCommands: true },
  ]]);
  framework.mcplServerRegistry = {
    getServer: (id: string) => id === 'discord' ? connection : null,
  };
  framework.mcplTools = [{ name: 'mcpl--discord--send_message' }];
  return framework as AgentFramework;
}

test('listMcplServers exposes the live grant layers and host-owned authority', () => {
  const grant = new CapabilityGrant(
    new Set(['channels.incoming', 'channels.publish']),
    ['contextHooks.beforeInference.inject.system'],
  );
  const framework = frameworkWithConnection({
    isConnected: true,
    willReconnect: true,
    policyEstablished: true,
    grant,
    droppedCapabilities: new Set(['channels.streaming']),
  });

  assert.deepEqual(framework.listMcplServers(), [{
    id: 'discord',
    connected: true,
    retrying: false,
    toolPrefix: 'mcpl--discord',
    toolCount: 1,
    policyEstablished: true,
    effectiveGrant: ['channels.incoming', 'channels.publish'],
    maskedCapabilities: ['channels.streaming'],
    deniedCapabilities: ['contextHooks.beforeInference.inject.system'],
    allowHostCommands: true,
    command: 'node',
    url: undefined,
  }]);
});

test('listMcplServers distinguishes a disconnected retrying stub from connected', () => {
  const framework = frameworkWithConnection({
    isConnected: false,
    willReconnect: true,
    policyEstablished: false,
    grant: CapabilityGrant.empty(),
    droppedCapabilities: new Set<string>(),
  });

  const [status] = framework.listMcplServers();
  assert.equal(status.connected, false);
  assert.equal(status.retrying, true);
  assert.equal(status.policyEstablished, false);
  assert.deepEqual(status.effectiveGrant, []);
});
