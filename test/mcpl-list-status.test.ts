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
  framework.mcplPrefixMap = new Map([['mcpl--discord', 'discord']]);
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
    family: 'legacy',
    // The stub never handshook, so no revision is established.
    protocolVersion: null,
    transport: 'stdio',
    refused: null,
    toolPrefix: 'mcpl--discord',
    toolCount: 1,
    policyEstablished: true,
    effectiveGrant: ['channels.incoming', 'channels.publish'],
    maskedCapabilities: ['channels.streaming'],
    deniedCapabilities: ['contextHooks.beforeInference.inject.system'],
    allowHostCommands: true,
    toolObserveFilter: null,
    // Unclassed here: the stub declares no class and no override.
    toolClasses: [{ tool: 'mcpl--discord--send_message', serverTool: 'send_message', class: [], source: 'none' }],
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

test('listMcplServers lists a refused configuration as refused, shows urls redacted, and gives a modern server no MCPL policy', () => {
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplServerConfigs = new Map<string, Record<string, unknown>>([
    ['both', { id: 'both', command: 'node', url: 'wss://u:pw@x.example/mcpl?token=sekret' }],
    ['slow', { id: 'slow', url: 'https://x.example/mcp', requestTimeoutMs: 0 }],
    // A deadline JSON can hold and String() can't print: listed as refused
    // rather than throwing out of the whole list.
    ['odd', { id: 'odd', url: 'https://x.example/mcp', requestTimeoutMs: JSON.parse('{"toString": 1}') }],
    ['docs', { id: 'docs', url: 'https://mcp.example/mcp?api_key=sekret&region=eu' }],
    ['chat', { id: 'chat', url: 'wss://user:pw@chat.example/mcpl' }],
    ['zap', { id: 'zap', url: 'https://mcp.zapier.com/api/mcp/s/sekretZt4kQ9xW2vLm8/mcp' }],
  ]);
  framework.mcplServerRegistry = { getServer: () => null };
  framework.mcplTools = [];
  framework.mcplPrefixMap = new Map();
  const listed = (framework as AgentFramework).listMcplServers();
  const byId = new Map(listed.map((s) => [s.id, s]));

  // No usable transport: no family or transport is guessed.
  const both = byId.get('both')!;
  assert.equal(both.family, null);
  assert.equal(both.transport, null);
  assert.match(both.refused!, /"command" and "url" are both set/);
  assert.equal(both.url, 'wss://x.example/mcpl?token=redacted');
  // A binding that resolves, refused for another reason.
  const slow = byId.get('slow')!;
  assert.equal(slow.family, 'modern');
  assert.equal(slow.transport, 'http');
  assert.match(slow.refused!, /requestTimeoutMs must be an integer from 1/);
  assert.match(byId.get('odd')!.refused!, /requestTimeoutMs must be an integer from 1 to 2147483647 for a modern server \(got \[a value that cannot be printed\]\)/);
  // Usable: nothing refused. MCPL policy doesn't apply to a modern server.
  const docs = byId.get('docs')!;
  assert.deepEqual([docs.family, docs.transport, docs.refused, docs.policyEstablished], ['modern', 'http', null, null]);
  assert.equal(docs.url, 'https://mcp.example/mcp?api_key=redacted&region=redacted');
  const chat = byId.get('chat')!;
  assert.deepEqual([chat.family, chat.transport, chat.refused, chat.policyEstablished], ['legacy', 'websocket', null, false]);
  assert.equal(chat.url, 'wss://chat.example/mcpl');
  // A per-user secret in the path goes too.
  assert.equal(byId.get('zap')!.url, 'https://mcp.zapier.com/api/mcp/s/redacted/mcp');
  assert.ok(!/sekret|pw@/.test(JSON.stringify(listed)), 'no credential in the status');
});
