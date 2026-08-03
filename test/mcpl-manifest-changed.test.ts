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

  /** Ordered record of what the host did to us, for ordering assertions. */
  events: Array<{ kind: string; detail?: unknown }> = [];
  /** Next mcpl/manifest answer; a function may throw to model fetch failure. */
  nextManifest: () => McplCapabilities = () => INITIAL;
  /** Whether featureSets/update Requests are answered. */
  answerPolicy = true;

  establishGrant(grant: CapabilityGrant): void {
    this.grant = grant;
    this.policyEstablished = true;
    this.events.push({ kind: 'grant', detail: grant.effectiveList() });
  }
  sendManifestRequest(): Promise<McplCapabilities> {
    this.events.push({ kind: 'fetch' });
    return Promise.resolve(this.nextManifest());
  }
  sendFeatureSetsUpdateRequest(params: unknown): Promise<{ accepted: true }> {
    this.events.push({ kind: 'policy-request', detail: params });
    if (!this.answerPolicy) return new Promise(() => {}); // never answers
    return Promise.resolve({ accepted: true });
  }
  sendFeatureSetsUpdate(): void {}
}

function makeHarness() {
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const fw = Object.create(AgentFramework.prototype) as any;
  fw.traceListeners = [(e: unknown) => traces.push(e as never)];
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
  fw.mcplServerRegistry = { getAllServers: () => [connection], getServer: (id: string) => (id === 'srv' ? connection : null) };

  // Model post-§5.3 state: initial policy done, full grant active.
  const grant = computeGrant(connection.capabilities, config, { mcpToolsAdvertised: false });
  fw.featureSetManager.initializeServer('srv', connection.capabilities!, {}, grant);
  connection.establishGrant(grant);
  connection.events = []; // discard setup noise

  return { fw, connection, traces };
}

const settle = () => new Promise((r) => setImmediate(r));

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
  connection.answerPolicy = false; // server never answers the new policy
  connection.nextManifest = () => ({
    version: '0.5',
    pushEvents: true,
    channels: { incoming: true, publish: true, streaming: true }, // + streaming
    featureSets: { chat: { description: 'chat', uses: ['pushEvents', 'channels.incoming', 'channels.publish'] } },
  }) as unknown as McplCapabilities;

  // Fire and give the pipeline a beat; the policy Request hangs forever.
  const p = fw.handleManifestChanged(connection, { revision: 'sha256:y', domains: ['capabilities'] });
  await settle(); await settle();
  assert.ok(!connection.grant.has('channels.streaming'),
    'unanswered expansion must not activate (§6.7)');
  assert.ok(connection.grant.has('channels.publish'),
    'no reduction occurred, so the standing grant survives');
  void p; // intentionally left pending — models the wedged server
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
