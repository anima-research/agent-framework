/**
 * §17 host-side manifest tracking (RFC-003, af#78).
 *
 * The load-bearing orderings, each pinned:
 *  - reduction applies BEFORE the post-manifest policy Request is sent
 *    (§6.7: security cannot wait on consent);
 *  - expansion activates only AFTER the receipt (an unanswered Request
 *    leaves the interim reduced grant standing);
 *  - a failed fetch teaches nothing — the previous manifest stands;
 *  - exactly ONE receipt trace per change, host-derived vocabulary;
 *  - announcements coalesce under the §17.8 fetch floor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AgentFramework } from '../src/framework.js';
import { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { McplServerRegistry } from '../src/mcpl/server-registry.js';
import { CapabilityGrant, computeGrant, expandAdvertisementShorthand } from '../src/mcpl/capability-grant.js';
import type { McplCapabilities, McplServerConfig } from '../src/mcpl/types.js';

const INITIAL: McplCapabilities = {
  version: '0.5',
  pushEvents: true,
  channels: { incoming: true, publish: true },
  featureSets: {
    chat: { description: 'chat', uses: ['pushEvents', 'channels.incoming', 'channels.publish'] },
  },
} as unknown as McplCapabilities;

class ManifestFake extends EventEmitter {
  readonly id = 'srv';
  capabilities: McplCapabilities | null = null;
  willReconnect = false;
  mcpToolsAdvertised = false;
  allowHostCommands = false;
  grant = CapabilityGrant.empty();
  policyEstablished = false;
  manifestState = { lastValidatedRevision: null as string | null, lastFetchedAt: null as number | null, lastNegotiatedAt: null as number | null };
  droppedCapabilities: ReadonlySet<string> = new Set();
  /** Moves on at each transport boundary, as the connection's does. */
  transportEpoch = 0;

  /** Ordered record of what the host did to us, for ordering assertions. */
  events: Array<{ kind: string; detail?: unknown }> = [];
  /** Next mcpl/manifest answer; a function may throw to model fetch failure. */
  nextManifest: () => McplCapabilities = () => INITIAL;
  /** How featureSets/update Requests are answered; the last two after the
   *  transport closed. */
  answerPolicy: 'accept' | 'never' | 'refuse-mcp-only' | 'refuse-close' | 'accept-after-close' | 'reject-on-close' = 'accept';
  closed = false;
  close(): Promise<void> { this.closed = true; return Promise.resolve(); }

  establishGrant(grant: CapabilityGrant): void {
    this.grant = grant;
    this.policyEstablished = true;
    this.events.push({ kind: 'grant', detail: grant.effectiveList() });
  }
  sendManifestRequest(): Promise<McplCapabilities> {
    this.events.push({ kind: 'fetch' });
    return Promise.resolve(this.nextManifest());
  }
  sendFeatureSetsUpdateRequest(params: unknown): Promise<unknown> {
    this.events.push({ kind: 'policy-request', detail: params });
    switch (this.answerPolicy) {
      case 'never': return new Promise(() => {});
      case 'refuse-mcp-only': return Promise.resolve({ accepted: false, fallback: 'mcp-only' });
      case 'refuse-close': return Promise.resolve({ accepted: false, fallback: 'close' });
      case 'accept-after-close': this.transportEpoch++; return Promise.resolve({ accepted: true });
      case 'reject-on-close': this.transportEpoch++; return Promise.reject(new Error('the connection closed before it answered'));
      default: return Promise.resolve({ accepted: true });
    }
  }
  sendFeatureSetsUpdate(): void {}
}

function makeHarness() {
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const fw = Object.create(AgentFramework.prototype) as any;
  fw.traceListeners = [];
  fw.onTrace((e: unknown) => traces.push(e as never));
  fw.featureSetManager = new FeatureSetManager();
  fw.mcplTools = [];
  fw.mcplToolRefreshInFlight = false;
  fw.mcplToolRefreshPending = false;
  fw.agents = new Map();
  fw.manifestRefreshState = new Map();
  fw.handleToolsListChanged = () => {};

  const config: McplServerConfig = { id: 'srv', command: 'unused' };
  fw.mcplServerConfigs = new Map([[config.id, config]]);

  const connection = new ManifestFake();
  connection.capabilities = expandAdvertisementShorthand(INITIAL);
  const registry = new McplServerRegistry();
  (registry as any).servers.set('srv', connection);
  fw.mcplServerRegistry = registry;

  // Model post-§5.3 state: initial policy done, full grant active.
  const grant = computeGrant(connection.capabilities, config, { mcpToolsAdvertised: false });
  fw.featureSetManager.initializeServer('srv', connection.capabilities!, {}, grant);
  connection.establishGrant(grant);
  connection.events = []; // discard setup noise

  return { fw, connection, traces, registry };
}

const settle = () => new Promise((r) => setImmediate(r));

test('a manifest change from a server with no configuration (removed) fetches nothing', async () => {
  const { fw, connection } = makeHarness();
  (fw as unknown as { mcplServerConfigs: Map<string, unknown> }).mcplServerConfigs = new Map();
  await fw.handleManifestChanged(connection, { revision: 'sha256:gone', domains: ['capabilities'] });
  assert.deepEqual(connection.events.map((e) => e.kind), [], 'no fetch, grant or policy request');
});

test('reduction applies BEFORE the policy Request; receipt names it applied', async () => {
  const { fw, connection, traces } = makeHarness();
  // New manifest drops channels.publish (and the chat set with it, since
  // uses requires it).
  connection.nextManifest = () => ({
    version: '0.5',
    pushEvents: true,
    channels: { incoming: true },
    featureSets: { chat: { description: 'chat', uses: ['pushEvents', 'channels.incoming', 'channels.publish'] } },
  }) as unknown as McplCapabilities;

  await fw.handleManifestChanged(connection, { revision: 'sha256:x', domains: ['capabilities'] });

  const kinds = connection.events.map((e) => e.kind);
  const firstGrant = kinds.indexOf('grant');
  const policyIdx = kinds.indexOf('policy-request');
  assert.ok(firstGrant >= 0 && policyIdx >= 0 && firstGrant < policyIdx,
    `reduction must land before the Request (got order: ${kinds.join(',')})`);
  const interim = connection.events[firstGrant].detail as string[];
  assert.ok(!interim.includes('channels.publish'), 'interim grant must not carry the revoked path');

  // After the receipt: final grant matches the new manifest; chat degraded
  // by §6.4 (its uses still names the revoked path).
  assert.ok(!connection.grant.has('channels.publish'));
  assert.equal(fw.featureSetManager.isEnabled('srv', 'chat'), false);

  const receipts = traces.filter((t) => t.type === 'mcpl:manifest-change-receipt');
  assert.equal(receipts.length, 1, 'exactly ONE receipt per change');
  const impacts = (receipts[0].impacts as Array<{ impact: string; subject: string; disposition: string }>);
  assert.ok(impacts.some((i) => i.impact === 'capability-revoked' && i.subject === 'channels.publish' && i.disposition === 'applied'));
  assert.ok(impacts.some((i) => i.impact === 'feature-degraded' && i.subject === 'chat'));
});

test('expansion activates only after the receipt; unanswered Request leaves it inactive', async () => {
  const { fw, connection } = makeHarness();
  connection.answerPolicy = 'never'; // server never answers the new policy
  connection.nextManifest = () => ({
    version: '0.5',
    pushEvents: true,
    channels: { incoming: true, publish: true, streaming: true }, // + streaming
    featureSets: {
      chat: { description: 'chat', uses: ['pushEvents', 'channels.incoming', 'channels.publish'] },
      // NEW set backed by the NEW capability — the §84-review probe.
      streamy: { description: 's', uses: ['channels.streaming'] },
    },
  }) as unknown as McplCapabilities;

  // Fire and give the pipeline a beat; the policy Request hangs forever.
  const p = fw.handleManifestChanged(connection, { revision: 'sha256:y', domains: ['capabilities'] });
  await settle(); await settle();
  assert.ok(!connection.grant.has('channels.streaming'),
    'unanswered expansion must not activate (§6.7)');
  assert.ok(connection.grant.has('channels.publish'),
    'no reduction occurred, so the standing grant survives');
  // Sol's #84 blocker: a NEW capability-backed feature set must not be
  // host-enabled while its capability is absent from the ACTIVE grant.
  assert.equal(fw.featureSetManager.isEnabled('srv', 'streamy'), false,
    'feature state must not run ahead of active authority');
  assert.equal(fw.featureSetManager.isEnabled('srv', 'chat'), true,
    'interim-derived state keeps what active authority supports');
  void p; // intentionally left pending — models the wedged server
});

test('refusal with fallback mcp-only: empty grant, empty-derived feature state', async () => {
  const { fw, connection } = makeHarness();
  connection.answerPolicy = 'refuse-mcp-only';
  connection.nextManifest = () => INITIAL;

  await fw.handleManifestChanged(connection, { revision: 'sha256:r1', domains: ['capabilities'] });

  assert.deepEqual(connection.grant.effectiveList(), [], 'mcp-only = empty grant, like the §5.3 path');
  assert.equal(fw.featureSetManager.isEnabled('srv', 'chat'), false,
    'feature state derives from the (empty) active grant');
  assert.equal(connection.closed, false);
});

test('refusal with fallback close: the transport is closed and the server unregistered', async () => {
  const { fw, connection, registry } = makeHarness();
  connection.answerPolicy = 'refuse-close';
  connection.nextManifest = () => INITIAL;

  await fw.handleManifestChanged(connection, { revision: 'sha256:r2', domains: ['capabilities'] });

  assert.equal(connection.closed, true, 'fallback close must be honored (§6.7)');
  // The fake's close() emits no 'close', as a server's doesn't once it's down
  // between retries, so only a close through the registry unregisters it.
  assert.equal(registry.getServer('srv'), null);
});

test('failed fetch: previous manifest and grant stand untouched', async () => {
  const { fw, connection, traces } = makeHarness();
  const before = connection.grant.effectiveList();
  connection.nextManifest = () => { throw new Error('boom'); };

  await fw.handleManifestChanged(connection, { revision: 'sha256:z', domains: ['featureSets'] });

  assert.deepEqual(connection.grant.effectiveList(), before);
  assert.equal(traces.filter((t) => t.type === 'mcpl:manifest-change-receipt').length, 0,
    'no receipt for a change the host could not observe');
});

test('announcements coalesce: rapid-fire N announces cause one immediate fetch', async () => {
  const { fw, connection } = makeHarness();
  connection.nextManifest = () => INITIAL;

  const first = fw.handleManifestChanged(connection, { revision: 'sha256:a', domains: [] });
  // While the first is in flight (or inside the floor window) these coalesce.
  void fw.handleManifestChanged(connection, { revision: 'sha256:b', domains: [] });
  void fw.handleManifestChanged(connection, { revision: 'sha256:c', domains: [] });
  await first; await settle();

  const fetches = connection.events.filter((e) => e.kind === 'fetch').length;
  assert.equal(fetches, 1, `rapid announcements must coalesce (§17.8), got ${fetches} fetches`);
});

test('an announcement without params is handled like any other: one receipt naming no domains, then the tools-list refresh', async () => {
  // A notification may carry no params. The announcement's fields are hints
  // the server sends; the change itself is read from the fetched manifest.
  const { fw, connection, traces } = makeHarness();
  let refreshed = 0;
  fw.handleToolsListChanged = () => { refreshed++; };
  connection.nextManifest = () => ({
    version: '0.5',
    pushEvents: true,
    channels: { incoming: true },
    featureSets: { chat: { description: 'chat', uses: ['pushEvents', 'channels.incoming', 'channels.publish'] } },
  }) as unknown as McplCapabilities;

  await fw.handleManifestChanged(connection, undefined);

  assert.ok(!connection.grant.has('channels.publish'), 'the fetched manifest was applied');
  const receipts = traces.filter((t) => t.type === 'mcpl:manifest-change-receipt');
  assert.equal(receipts.length, 1, 'exactly one receipt');
  assert.deepEqual(receipts[0].announcedDomains, []);
  assert.equal(refreshed, 1, 'the tools list was refreshed');
});

test("an announcement's domains are reported only as strings: anything else names none", async () => {
  const { fw, traces } = makeHarness();
  const domainsOf = async (announce: unknown) => {
    fw.manifestRefreshState = new Map(); // each announcement its own refresh, past the floor
    const before = traces.length;
    await fw.handleManifestChanged(fw.mcplServerRegistry.getServer('srv'), announce);
    return traces.slice(before).filter((t) => t.type === 'mcpl:manifest-change-receipt').map((t) => t.announcedDomains);
  };
  assert.deepEqual(await domainsOf({ domains: 'capabilities' }), [[]]);
  assert.deepEqual(await domainsOf({ domains: ['capabilities', 7, null, 'featureSets'] }), [['capabilities', 'featureSets']]);
  assert.deepEqual(await domainsOf('capabilities'), [[]]);
  assert.deepEqual(await domainsOf(null), [[]], 'params: null, as a server may send them');
});

/** A manifest that adds a capability, and a feature set backed by it. */
const EXPANDED = (): McplCapabilities => ({
  version: '0.5',
  pushEvents: true,
  channels: { incoming: true, publish: true, streaming: true },
  featureSets: {
    chat: { description: 'chat', uses: ['pushEvents', 'channels.incoming', 'channels.publish'] },
    streamy: { description: 's', uses: ['channels.streaming'] },
  },
}) as unknown as McplCapabilities;

test('a manifest answer from a transport that closed meanwhile is not installed', async () => {
  const { fw, connection, traces } = makeHarness();
  const before = connection.capabilities;
  connection.nextManifest = () => { connection.transportEpoch++; return EXPANDED(); };
  await fw.handleManifestChanged(connection, { revision: 'sha256:gone', domains: ['capabilities'] });
  assert.deepEqual(connection.events.map((e) => e.kind), ['fetch'], 'no grant and no policy Request');
  assert.equal(connection.capabilities, before);
  assert.equal(traces.some((t) => t.type === 'mcpl:manifest-change-receipt'), false);
});

for (const [mode, what] of [['accept-after-close', 'an answer'], ['reject-on-close', 'a Request the close ended']] as const) {
  test(`a post-manifest policy ${what} after its transport closed installs nothing`, async (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const { fw, connection, traces } = makeHarness();
    const before = connection.capabilities;
    connection.answerPolicy = mode;
    connection.nextManifest = EXPANDED;
    await fw.handleManifestChanged(connection, { revision: 'sha256:z', domains: ['capabilities'] });
    assert.equal(connection.grant.has('channels.streaming'), false, 'no grant from the dead transport');
    assert.equal(connection.capabilities, before, 'its manifest is not adopted');
    assert.equal(connection.manifestState.lastValidatedRevision, null);
    assert.equal(traces.some((x) => x.type === 'mcpl:manifest-change-receipt'), false);
    const said = mode === 'accept-after-close' ? 'post-manifest policy answer arrived after its transport closed' : "post-manifest policy Request ended by its transport's close";
    assert.ok(logged.some((line) => line.includes(said)), logged.join('\n'));
    assert.equal(logged.some((line) => line.includes('did not answer post-manifest policy')), false);
  });
}

test('a refresh queued behind a fetch whose transport closed meanwhile is not run against the next transport', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { fw, connection, traces } = makeHarness();
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  const fetch = connection.sendManifestRequest.bind(connection);
  let first = true;
  connection.sendManifestRequest = async () => {
    const manifest = await fetch();
    if (first) {
      first = false;
      await answered;
      connection.transportEpoch++; // its transport closed while the answer was on its way
    }
    return manifest;
  };
  connection.nextManifest = EXPANDED;
  const run = fw.handleManifestChanged(connection, { revision: 'sha256:a', domains: ['capabilities'] });
  // A second announcement from the same transport while the first fetch is out queues behind it.
  void fw.handleManifestChanged(connection, { revision: 'sha256:b', domains: ['capabilities'] });
  assert.equal(fw.manifestRefreshState.get(connection).queued, true, 'queued behind the fetch');
  answer();
  await run;
  // The next transport's initialize and policy exchange start afresh, so the
  // dead transport's queued refresh has nothing to fetch or negotiate there.
  t.mock.timers.tick(5_000);
  await settle();
  assert.deepEqual(connection.events.map((e) => e.kind), ['fetch'], 'one fetch, on the transport that closed');
  assert.equal(traces.some((x) => x.type === 'mcpl:manifest-change-receipt'), false);
});

test('a refresh queued behind a fetch on the same transport runs once the floor has passed, with its announcement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { fw, connection, traces } = makeHarness();
  const run = fw.handleManifestChanged(connection, { revision: 'sha256:a', domains: ['first'] });
  void fw.handleManifestChanged(connection, { revision: 'sha256:b', domains: ['second'] }); // queues behind the fetch
  await run;
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(connection.events.filter((e) => e.kind === 'fetch').length, 2, 'the queued refresh fetched');
  const receipts = traces.filter((x) => x.type === 'mcpl:manifest-change-receipt');
  assert.deepEqual(receipts.at(-1)?.announcedDomains, ['second'], 'with the announcement it holds');
});

test('a refresh two announcements queued behind a fetch reports both their domains, each once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { fw, connection, traces } = makeHarness();
  const run = fw.handleManifestChanged(connection, { revision: 'sha256:a', domains: ['a'] });
  void fw.handleManifestChanged(connection, { revision: 'sha256:b', domains: ['b', 'x'] }); // both coalesce behind the fetch
  void fw.handleManifestChanged(connection, { revision: 'sha256:c', domains: ['c', 'x'] });
  await run;
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(connection.events.filter((e) => e.kind === 'fetch').length, 2, 'one trailing fetch');
  const receipts = traces.filter((x) => x.type === 'mcpl:manifest-change-receipt');
  assert.deepEqual(receipts.at(-1)?.announcedDomains, ['b', 'x', 'c'], 'its fetch answers both');
});

test('a later refresh coalesced on the same transport reports only its own announcements', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { fw, connection, traces } = makeHarness();
  const run = fw.handleManifestChanged(connection, { revision: 'sha256:a', domains: ['a'] });
  void fw.handleManifestChanged(connection, { revision: 'sha256:b', domains: ['b'] }); // behind the fetch
  await run;
  t.mock.timers.tick(5_000);
  await settle();
  void fw.handleManifestChanged(connection, { revision: 'sha256:c', domains: ['c'] }); // under the floor
  t.mock.timers.tick(5_000);
  await settle();
  void fw.handleManifestChanged(connection, { revision: 'sha256:d', domains: ['d'] }); // under the floor again
  t.mock.timers.tick(5_000);
  await settle();
  const receipts = traces.filter((x) => x.type === 'mcpl:manifest-change-receipt');
  assert.deepEqual(receipts.map((x) => x.announcedDomains), [['a'], ['b'], ['c'], ['d']]);
});

test("a connection that replaces a removed server under its id starts its own limiter, beside the timer the removed one's fetch set", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { fw, connection } = makeHarness();
  const run = fw.handleManifestChanged(connection, { revision: 'sha256:a', domains: [] });
  void fw.handleManifestChanged(connection, { revision: 'sha256:b', domains: [] }); // queues behind the fetch
  await run; // its finally sets the queued refresh's timer
  connection.transportEpoch++; // the server is removed: its close crosses a boundary
  const replacement = new ManifestFake();
  replacement.capabilities = connection.capabilities;
  replacement.establishGrant(connection.grant);
  await fw.handleManifestChanged(replacement, { revision: 'sha256:c', domains: [] });
  assert.equal(replacement.events.filter((e) => e.kind === 'fetch').length, 1, 'fetched at once, under no floor of the removed one');
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(connection.events.filter((e) => e.kind === 'fetch').length, 1, 'nothing more on the removed connection');
  assert.equal(replacement.events.filter((e) => e.kind === 'fetch').length, 1);
});

test('a refresh queued under the floor whose transport closed before it was due is not run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { fw, connection } = makeHarness();
  await fw.handleManifestChanged(connection, { revision: 'sha256:a', domains: [] });
  void fw.handleManifestChanged(connection, { revision: 'sha256:b', domains: [] }); // inside the floor: queued
  assert.equal(fw.manifestRefreshState.get(connection).queued, true, 'queued under the floor');
  connection.transportEpoch++; // its transport closed
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(connection.events.filter((e) => e.kind === 'fetch').length, 1);
});

test("a refresh queued under the floor that the next transport's announcement joined runs on that transport, with its announcement", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { fw, connection, traces } = makeHarness();
  await fw.handleManifestChanged(connection, { revision: 'sha256:a', domains: [] });
  void fw.handleManifestChanged(connection, { revision: 'sha256:b', domains: ['old-transport'] }); // inside the floor: queued
  connection.transportEpoch++; // its transport closed, and the next one announces
  void fw.handleManifestChanged(connection, { revision: 'sha256:c', domains: ['next-transport'] });
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(connection.events.filter((e) => e.kind === 'fetch').length, 2, "the next transport's announcement is fetched");
  const receipts = traces.filter((x) => x.type === 'mcpl:manifest-change-receipt');
  assert.deepEqual(receipts.at(-1)?.announcedDomains, ['next-transport'], 'with the announcement it holds');
});

test("a timer of a removed server's refresh leaves its replacement's queued refresh alone", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { fw, connection, traces } = makeHarness();
  await fw.handleManifestChanged(connection, { revision: 'sha256:a', domains: [] });
  void fw.handleManifestChanged(connection, { revision: 'sha256:b', domains: ['removed'] }); // its floor timer is pending
  // The server is removed, its close crossing a boundary, and a replacement
  // connection under the same id announces twice: once at once, once under
  // its own floor.
  connection.transportEpoch++;
  const replacement = new ManifestFake();
  replacement.capabilities = connection.capabilities;
  replacement.establishGrant(connection.grant);
  t.mock.timers.tick(1_000);
  await fw.handleManifestChanged(replacement, { revision: 'sha256:c', domains: [] });
  void fw.handleManifestChanged(replacement, { revision: 'sha256:d', domains: ['replacement'] });
  t.mock.timers.tick(4_000); // the removed connection's timer is due
  await settle();
  t.mock.timers.tick(1_000); // the replacement's is due
  await settle();
  assert.equal(connection.events.filter((e) => e.kind === 'fetch').length, 1, 'nothing more on the removed connection');
  assert.equal(replacement.events.filter((e) => e.kind === 'fetch').length, 2, "the replacement's queued refresh ran");
  const receipts = traces.filter((x) => x.type === 'mcpl:manifest-change-receipt');
  assert.deepEqual(receipts.at(-1)?.announcedDomains, ['replacement'], "with the replacement's announcement");
});
