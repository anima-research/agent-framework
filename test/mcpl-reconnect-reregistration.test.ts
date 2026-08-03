/**
 * MCPL auto-reconnect must RE-REGISTER the server, not just refresh tools.
 *
 * Before the fix, the 'close' handler removed the server from the
 * FeatureSetManager (and destroyed its checkpoint trees), while the
 * 'reconnect' handler only re-listed tools. Result: after any transient
 * crash + successful reconnect, validateInbound threw "Unknown server"
 * forever — every push event and inference request rejected until a full
 * host restart — and the server's durable checkpoint state was gone.
 *
 * These tests exercise the framework's wireMcplEvents close/reconnect
 * handlers with the REAL FeatureSetManager / CheckpointManager / PushHandler
 * and a fake connection (EventEmitter), asserting:
 *   1. a push event after close→reconnect is ACCEPTED again;
 *   2. checkpoint state SURVIVES any close (transient OR clean shutdown);
 *   3. checkpoint state is destroyed only via disconnectMcplServer (explicit
 *      permanent removal), never by the close handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AgentFramework } from '../src/framework.js';
import { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { ScopeManager } from '../src/mcpl/scope-manager.js';
import { CheckpointManager } from '../src/mcpl/checkpoint-manager.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { PushHandler } from '../src/mcpl/push-handler.js';
import type { McplCapabilities, McplServerConfig, PushEventResult } from '../src/mcpl/types.js';

/** In-memory JsStore stub — CheckpointManager only needs the state-slot API. */
function makeStoreStub() {
  const slots = new Map<string, unknown>();
  return {
    slots,
    registerState: (_opts: { id: string; strategy: string }) => {},
    setStateJson: (id: string, value: unknown) => { slots.set(id, structuredClone(value)); },
    getStateJson: (id: string) => slots.get(id) ?? null,
  };
}

const CAPABILITIES: McplCapabilities = {
  version: '0.5',
  // §6.4 derivation runs against the computed grant now: the advertisement
  // must cover each feature set's `uses` or derivation disables it before
  // any push is attempted.
  pushEvents: true,
  tools: true,
  featureSets: {
    chat: { description: 'chat events', uses: ['pushEvents'] },
    mem: { description: 'stateful memory', uses: ['tools'], hostState: true, rollback: true },
  },
} as unknown as McplCapabilities;

class FakeConnection extends EventEmitter {
  readonly id: string;
  capabilities: McplCapabilities | null = CAPABILITIES;
  willReconnect = true;
  featureSetUpdates: unknown[] = [];
  onReady: (() => void) | undefined;
  // 0.5 surface (§5.3/§6.7): the framework now sends the initial policy as a
  // Request and activates the grant on the receipt. The fake answers
  // accepted — modeling a conforming 0.5 server — so registration reaches
  // establishGrant and post-policy tests exercise delivery, not denial.
  grant = CapabilityGrant.empty();
  // §5.1: `tools` comes from the OUTER standard MCP capabilities — the
  // experimental advert can't mint it. mem uses ['tools'], so the fake
  // models a server whose initialize carried capabilities.tools.
  mcpToolsAdvertised = true;
  policyEstablished = false;
  establishGrant(grant: CapabilityGrant): void {
    this.grant = grant;
    this.policyEstablished = true;
  }
  sendFeatureSetsUpdateRequest(params: unknown): Promise<{ accepted: true }> {
    this.featureSetUpdates.push(params);
    return Promise.resolve({ accepted: true });
  }
  constructor(id: string) {
    super();
    this.id = id;
  }
  sendFeatureSetsUpdate(params: unknown): void {
    this.featureSetUpdates.push(params);
  }
  pauseDataPlane(): void {}
  readyControlPlane(): void {}
  ready(): void {
    const callback = this.onReady;
    this.onReady = undefined;
    callback?.();
  }
}

async function makeHarness() {
  const store = makeStoreStub();
  const traces: Array<{ type: string }> = [];
  const pushed: unknown[] = [];

  const fw = Object.create(AgentFramework.prototype) as any;
  fw.traceListeners = [];
  fw.consecutiveInferenceFailures = new Map();
  fw.exhaustionRewinds = new Map();
  fw.agents = new Map();
  fw.mcplTools = [];
  fw.mcplToolRefreshInFlight = false;
  fw.mcplToolRefreshPending = false;
  fw.channelRegistry = null;
  fw.inferenceRouter = null;
  fw.eventGate = null;

  fw.featureSetManager = new FeatureSetManager();
  fw.scopeManager = new ScopeManager();
  fw.checkpointManager = new CheckpointManager(store as never, (e: any) => traces.push(e));
  fw.pushHandler = new PushHandler(
    fw.featureSetManager,
    (e: unknown) => pushed.push(e),
    (e: any) => traces.push(e),
  );

  const config: McplServerConfig = {
    id: 'srv',
    command: 'unused',
    enabledFeatureSets: ['chat', 'mem'],
    reconnect: true,
  };
  fw.mcplServerConfigs = new Map([[config.id, config]]);

  const connection = new FakeConnection('srv');
  fw.mcplServerRegistry = {
    getAllServers: () => [connection],
    getServer: (id: string) => id === connection.id ? connection : null,
  };
  fw.discordAwarenessBarrier = null;
  fw.discordAwarenessBarrierGeneration = 0;
  fw.wireMcplEvents(connection);
  await fw.registerMcplServerFeatures(config, connection);

  // The push handler responds synchronously when no awareness barrier is
  // up, but during reconnect the §5.3 policy round-trip holds the barrier
  // across a microtask — so the harness settles the loop once before
  // asserting. (Was 'must respond synchronously' pre-0.5.)
  const sendPush = async (eventId: string): Promise<PushEventResult> => {
    let result: PushEventResult | undefined;
    connection.emit(
      'push-event',
      {
        featureSet: 'chat',
        eventId,
        timestamp: new Date().toISOString(),
        payload: { content: [{ type: 'text', text: 'hello' }] },
      },
      {
        respond: (r: PushEventResult) => { result = r; },
        respondError: (_c: number, m: string) => { result = { accepted: false, reason: m }; },
      },
    );
    if (!result) await new Promise((r) => setImmediate(r));
    assert.ok(result, 'push handler must respond within one settle');
    return result!;
  };

  return { fw, store, connection, config, sendPush, pushed, traces };
}

test('reconnect re-registers the server: pushes are accepted again after close→reconnect', async () => {
  const { fw, connection, sendPush, pushed } = await makeHarness();

  // Sanity: initial registration accepts pushes.
  assert.equal((await sendPush('e1')).accepted, true);
  assert.equal(pushed.length, 1);

  // Transient crash: transport closed, background reconnect pending.
  connection.willReconnect = true;
  connection.emit('close', null, 'SIGKILL');

  // While down, the server is deregistered — pushes are rejected.
  const down = await sendPush('e2');
  assert.equal(down.accepted, false);
  assert.match(down.reason ?? '', /Unknown server/);

  // Reconnect succeeded (fresh handshake refreshed capabilities).
  // Zero pending awareness work takes the synchronous full-ready path. Model a
  // push already buffered on the fresh transport: ready() flushes it in the
  // reconnect listener's stack, after host-side feature re-registration.
  let duringReconnect: PushEventResult | undefined;
  let e3: Promise<PushEventResult> | undefined;
  connection.onReady = () => { e3 = sendPush('e3'); };
  connection.emit('reconnect', { attempts: 1 });
  // Re-registration is async since the §5.3 policy Request: the reconnect
  // listener awaits the receipt before releasing the data plane, so settle
  // the microtask chain before asserting what happened at ready().
  await new Promise((r) => setImmediate(r));
  duringReconnect = await e3;
  assert.equal(duringReconnect?.accepted, true);

  // THE regression: before the fix this stayed rejected forever.
  const revived = await sendPush('e4');
  assert.equal(revived.accepted, true, `push after reconnect must be accepted, got: ${revived.reason}`);
  assert.equal(pushed.length, 3);

  // The server was told its enabled feature sets again on re-registration.
  assert.equal(connection.featureSetUpdates.length, 2, 'featureSets/update re-sent on reconnect');
  assert.ok(fw.featureSetManager.isEnabled('srv', 'chat'));
});

test('checkpoint state SURVIVES a transient close + reconnect', async () => {
  const { fw, store, connection } = await makeHarness();

  // Record durable checkpoint state for the stateful feature set.
  fw.checkpointManager.recordCheckpoint('srv', 'mem', {
    checkpoint: 'cp1',
    data: { counter: 42 },
  });
  assert.equal(fw.checkpointManager.getCurrentCheckpoint('srv', 'mem'), 'cp1');

  // Transient close: reconnect loop is active.
  connection.willReconnect = true;
  connection.emit('close', 1, null);

  assert.equal(
    fw.checkpointManager.getCurrentCheckpoint('srv', 'mem'), 'cp1',
    'a transient disconnect must NOT destroy checkpoint trees',
  );
  const persisted = store.slots.get('mcpl/checkpoints') as { trees: Record<string, unknown> };
  assert.ok(persisted.trees['srv:mem'], 'the persisted tree must not be deleted from Chronicle');

  // Reconnect: idempotent re-registration resumes (not resets) the tree.
  connection.emit('reconnect', { attempts: 1 });
  assert.equal(fw.checkpointManager.getCurrentCheckpoint('srv', 'mem'), 'cp1');
  assert.deepEqual(fw.checkpointManager.getCurrentState('srv', 'mem'), { counter: 42 });
});

test('the close handler NEVER destroys checkpoints — even with willReconnect=false', async () => {
  // A clean AgentFramework.stop() sets reconnectEnabled=false BEFORE emitting
  // 'close', so willReconnect is false on an ordinary host restart just as much
  // as on a permanent teardown. Gating checkpoint destruction on willReconnect
  // would therefore erase every durable checkpoint tree on a polite restart
  // (while a SIGKILL, whose 'close' carries willReconnect=true, preserved them).
  // Permanent removal is owned solely by disconnectMcplServer; the close handler
  // must leave the persisted tree intact for loadFromStore() to resume.
  const { fw, store, connection } = await makeHarness();

  fw.checkpointManager.recordCheckpoint('srv', 'mem', { checkpoint: 'cp1', data: { x: 1 } });

  // Even a "permanent-looking" close (reconnect disabled) must not delete state.
  connection.willReconnect = false;
  connection.emit('close', 0, null);

  assert.equal(
    fw.checkpointManager.getCurrentCheckpoint('srv', 'mem'), 'cp1',
    'the close handler must not destroy checkpoints on a clean shutdown',
  );
  const persisted = store.slots.get('mcpl/checkpoints') as { trees: Record<string, unknown> };
  assert.ok(persisted.trees['srv:mem'], 'the persisted tree survives a clean shutdown for later resume');
});

test('disconnectMcplServer destroys checkpoints even when the connection already closed transiently', async () => {
  const { fw, connection, config } = await makeHarness();

  fw.checkpointManager.recordCheckpoint('srv', 'mem', { checkpoint: 'cp1', data: { x: 1 } });

  // Transient close first (checkpoints preserved for the pending reconnect)…
  connection.willReconnect = true;
  connection.emit('close', 1, null);
  assert.equal(fw.checkpointManager.getCurrentCheckpoint('srv', 'mem'), 'cp1');

  // …then the operator permanently removes the server. close() on an
  // already-closed connection emits no second 'close', so the explicit
  // cleanup in disconnectMcplServer must handle it.
  fw.mcplServerRegistry = {
    removeServer: async () => {},
    getAllServers: () => [],
    getServer: () => null,
  };
  fw.mcplPrefixMap = new Map([[`mcpl--srv`, 'srv']]);
  await fw.disconnectMcplServer(config.id);

  assert.equal(fw.checkpointManager.getCurrentCheckpoint('srv', 'mem'), null);
  assert.equal(fw.featureSetManager.isEnabled('srv', 'chat'), false);
});
