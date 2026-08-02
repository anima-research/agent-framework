/**
 * Host-side MCPL capability scoping (McplServerConfig.enabledCapabilities /
 * disabledCapabilities).
 *
 * A server names its own capabilities in its initialize response, and hook
 * fan-out keys off that self-advertisement — so before this knob existed,
 * connecting any server that said `contextHooks.afterInference` was
 * equivalent to giving it a transcript of everything the agent says. The
 * mask intersects the advertisement with host policy at handshake time
 * (both directions: the host never fans out to a masked hook, and inbound
 * methods gated by a masked capability are rejected at the connection).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { maskNegotiatedCapabilities } from '../src/mcpl/capability-mask.js';
import { CAPABILITY_DISABLED } from '../src/mcpl/errors.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { McplCapabilities, McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

// ============================================================================
// Unit: maskNegotiatedCapabilities
// ============================================================================

const FULL_ADVERT: McplCapabilities = {
  version: '0.4',
  pushEvents: true,
  contextHooks: { beforeInference: true, afterInference: { blocking: true } },
  inferenceRequest: { streaming: true },
  modelInfo: true,
  featureSets: { 'memory.retrieval': { description: 'd', uses: [] } },
  channels: { register: true, publish: true, streaming: true },
};

test('no scoping config: advertisement passes through untouched', () => {
  const { capabilities, dropped } = maskNegotiatedCapabilities(FULL_ADVERT, {});
  assert.deepEqual(capabilities, FULL_ADVERT);
  assert.deepEqual(dropped, []);
});

test('disabledCapabilities drops a single hook, preserving its sibling and value shapes', () => {
  const { capabilities, dropped } = maskNegotiatedCapabilities(FULL_ADVERT, {
    disabledCapabilities: ['contextHooks.afterInference'],
  });
  assert.equal(capabilities?.contextHooks?.beforeInference, true);
  assert.equal(capabilities?.contextHooks?.afterInference, undefined);
  // Untouched capabilities keep their original (non-boolean) values.
  assert.deepEqual(capabilities?.inferenceRequest, { streaming: true });
  assert.deepEqual(dropped, ['contextHooks.afterInference']);
});

test('a parent pattern prunes the whole subtree, recorded as the bare path', () => {
  const { capabilities, dropped } = maskNegotiatedCapabilities(FULL_ADVERT, {
    disabledCapabilities: ['contextHooks'],
  });
  assert.equal(capabilities?.contextHooks, undefined);
  assert.deepEqual(dropped, ['contextHooks']);
});

test('refinement masking: inferenceRequest.streaming is addressable and leaves the capability granted', () => {
  const { capabilities, dropped } = maskNegotiatedCapabilities(FULL_ADVERT, {
    disabledCapabilities: ['inferenceRequest.streaming'],
  });
  // The capability hull survives — still truthy for getServersWithCapability.
  assert.deepEqual(capabilities?.inferenceRequest, {});
  assert.deepEqual(dropped, ['inferenceRequest.streaming']);
});

test('generic recursion: depth-3 paths are addressable (SPEC 0.5 §5.4 vocabulary shape)', () => {
  const advert = {
    version: '0.5',
    contextHooks: {
      beforeInference: { observe: true, inject: { system: true, beforeUser: true } },
    },
  } as unknown as McplCapabilities;
  const { capabilities, dropped } = maskNegotiatedCapabilities(advert, {
    disabledCapabilities: ['contextHooks.beforeInference.inject.system'],
  });
  const before = (capabilities as unknown as Record<string, Record<string, unknown>>)
    .contextHooks.beforeInference as Record<string, unknown>;
  assert.equal(before.observe, true);
  assert.deepEqual(before.inject, { beforeUser: true });
  assert.deepEqual(dropped, ['contextHooks.beforeInference.inject.system']);
});

test('wildcard pattern contextHooks.* masks both hooks', () => {
  const { capabilities } = maskNegotiatedCapabilities(FULL_ADVERT, {
    disabledCapabilities: ['contextHooks.*'],
  });
  assert.equal(capabilities?.contextHooks, undefined);
  assert.equal(capabilities?.pushEvents, true);
});

test('enabledCapabilities allow-list keeps only matches; disabled wins on conflict', () => {
  const { capabilities, dropped } = maskNegotiatedCapabilities(FULL_ADVERT, {
    enabledCapabilities: ['pushEvents', 'channels'],
    disabledCapabilities: ['channels.streaming'],
  });
  assert.equal(capabilities?.pushEvents, true);
  assert.deepEqual(capabilities?.channels, { register: true, publish: true });
  assert.equal(capabilities?.contextHooks, undefined);
  assert.equal(capabilities?.inferenceRequest, undefined);
  assert.equal(capabilities?.modelInfo, undefined);
  assert.ok(dropped.includes('channels.streaming'));
  assert.ok(dropped.includes('contextHooks.afterInference'));
});

test('version and featureSets are never masked', () => {
  const { capabilities } = maskNegotiatedCapabilities(FULL_ADVERT, {
    disabledCapabilities: ['*'],
  });
  assert.equal(capabilities?.version, '0.4');
  assert.deepEqual(capabilities?.featureSets, FULL_ADVERT.featureSets);
  assert.equal(capabilities?.pushEvents, undefined);
  assert.equal(capabilities?.contextHooks, undefined);
  assert.equal(capabilities?.channels, undefined);
});

test('boolean-form channels (discord-mcpl style) is maskable as a leaf', () => {
  const advert: McplCapabilities = {
    version: '0.4',
    pushEvents: true,
    channels: true as unknown as McplCapabilities['channels'],
  };
  const { capabilities, dropped } = maskNegotiatedCapabilities(advert, {
    disabledCapabilities: ['channels'],
  });
  assert.equal(capabilities?.channels, undefined);
  assert.equal(capabilities?.pushEvents, true);
  assert.deepEqual(dropped, ['channels']);
});

test('masking every advertised channel flag records the bare parent for inbound enforcement', () => {
  const { dropped } = maskNegotiatedCapabilities(FULL_ADVERT, {
    disabledCapabilities: ['channels.register', 'channels.publish', 'channels.streaming'],
  });
  assert.ok(dropped.includes('channels'));
});

test('flag-level channel masking does NOT record the bare parent', () => {
  const { dropped } = maskNegotiatedCapabilities(FULL_ADVERT, {
    disabledCapabilities: ['channels.streaming'],
  });
  assert.ok(!dropped.includes('channels'));
  assert.deepEqual(dropped, ['channels.streaming']);
});

test('null capabilities (plain MCP server) pass through', () => {
  const { capabilities, dropped } = maskNegotiatedCapabilities(null, {
    disabledCapabilities: ['*'],
  });
  assert.equal(capabilities, null);
  assert.deepEqual(dropped, []);
});

// ============================================================================
// End-to-end: handshake masking + registry queries + inbound rejection
// ============================================================================

// Stdio server that advertises the full MCPL surface, then (on tools/list —
// used here as a "go" signal) sends a push/event request and reports the
// host's response back through the tools/list result. This lets one
// round-trip prove both directions of the mask.
const CHATTY_SERVER = `
let buf = '';
let pushResponse = null;
let pendingToolsList = null;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: { capabilities: { experimental: { mcpl: {
        version: '0.4',
        pushEvents: true,
        contextHooks: { beforeInference: true, afterInference: { blocking: true } },
        channels: { register: true, publish: true },
      } } } } });
    } else if (m.method === 'tools/list') {
      pendingToolsList = m.id;
      send({ jsonrpc: '2.0', id: 77, method: 'push/event', params: {
        eventId: 'e1', featureSet: 'memory.retrieval', eventType: 'test', urgency: 'whenever',
      } });
    } else if (m.id === 77) {
      // Host's response to our push — report it via the parked tools/list.
      send({ jsonrpc: '2.0', id: pendingToolsList, result: { tools: [], pushResponse: m } });
    }
  }
});
setInterval(() => {}, 1 << 30);
`;

const HOST_CAPS: McplHostCapabilities = {
  version: '0.4',
  pushEvents: true,
  contextHooks: { beforeInference: true, afterInference: { blocking: true } },
  featureSets: true,
};

function config(overrides?: Partial<McplServerConfig>): McplServerConfig {
  return {
    id: 'chatty',
    command: process.execPath,
    args: ['-e', CHATTY_SERVER],
    ...overrides,
  };
}

let registry: McplServerRegistry | null = null;
afterEach(async () => {
  await registry?.closeAll();
  registry = null;
});

test('masked afterInference is invisible to capability queries; unmasked hooks survive', async () => {
  registry = new McplServerRegistry();
  const connection = await registry.addServer(
    config({ disabledCapabilities: ['contextHooks.afterInference'] }),
    HOST_CAPS,
  );
  connection.ready();

  assert.equal(connection.capabilities?.contextHooks?.beforeInference, true);
  assert.equal(connection.capabilities?.contextHooks?.afterInference, undefined);
  assert.deepEqual(registry.getServersWithCapability('contextHooks.afterInference'), []);
  assert.equal(registry.getServersWithCapability('contextHooks.beforeInference').length, 1);
  // pushEvents untouched — scoping is per-capability, not per-server.
  assert.equal(registry.getServersWithCapability('pushEvents').length, 1);
});

test('inbound push/event from a pushEvents-masked server is rejected with CAPABILITY_DISABLED', async () => {
  registry = new McplServerRegistry();
  const connection = await registry.addServer(
    config({ disabledCapabilities: ['pushEvents'] }),
    HOST_CAPS,
  );
  connection.ready();

  let pushEventEmitted = false;
  connection.on('push-event', () => { pushEventEmitted = true; });

  // tools/list triggers the server's push/event; its result carries the
  // host's JSON-RPC response to that push.
  const result = await connection.sendToolsList() as {
    tools: unknown[];
    pushResponse?: { error?: { code: number; message: string } };
  };

  assert.equal(pushEventEmitted, false, 'masked push must not reach host handlers');
  assert.equal(result.pushResponse?.error?.code, CAPABILITY_DISABLED);
  assert.match(result.pushResponse?.error?.message ?? '', /pushEvents/);
});

test('without scoping, the same push/event reaches host handlers', async () => {
  registry = new McplServerRegistry();
  const connection = await registry.addServer(config(), HOST_CAPS);
  connection.ready();

  const pushSeen = new Promise<void>((resolve) => {
    connection.on('push-event', (_params: unknown, responder?: { respond: (r: unknown) => void }) => {
      responder?.respond({ accepted: true });
      resolve();
    });
  });

  await connection.sendToolsList();
  await pushSeen;
});
