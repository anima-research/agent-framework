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
  const connection = {
    isConnected: true,
    willReconnect: true,
    policyEstablished: true,
    grant,
    droppedCapabilities: new Set(['channels.streaming']),
    manifestState: {
      lastValidatedRevision: 'sha256:validated',
      lastFetchedAt: 1_786_000_000_000,
      lastNegotiatedAt: 1_786_000_000_100,
    },
  };
  const framework = frameworkWithConnection(connection);

  const listed = framework.listMcplServers();
  assert.deepEqual(listed, [{
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
    manifestState: {
      lastValidatedRevision: 'sha256:validated',
      lastFetchedAt: 1_786_000_000_000,
      lastNegotiatedAt: 1_786_000_000_100,
    },
    command: 'node',
    url: undefined,
  }]);
  assert.notStrictEqual(listed[0]!.manifestState, connection.manifestState);
});

test('listMcplServers distinguishes a disconnected retrying stub from connected', () => {
  const framework = frameworkWithConnection({
    isConnected: false,
    willReconnect: true,
    policyEstablished: false,
    grant: CapabilityGrant.empty(),
    droppedCapabilities: new Set<string>(),
    manifestState: {
      lastValidatedRevision: null,
      lastFetchedAt: null,
      lastNegotiatedAt: null,
    },
  });

  const [status] = framework.listMcplServers();
  assert.equal(status.connected, false);
  assert.equal(status.retrying, true);
  assert.equal(status.policyEstablished, false);
  assert.deepEqual(status.effectiveGrant, []);
  assert.deepEqual(status.manifestState, {
    lastValidatedRevision: null,
    lastFetchedAt: null,
    lastNegotiatedAt: null,
  });
});
