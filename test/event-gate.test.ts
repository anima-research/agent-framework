import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gateModule from '../src/gate/event-gate.js';
import { EventGate, wakeProvenance, type WakeWrite, type WritePlacement } from '../src/gate/event-gate.js';

/** The gate's internal mark of the rows a batched wake's line can name, read
 *  loosely so this file still runs, red, against a gate without it. */
const BATCH_LINE_ROWS: symbol = (gateModule as unknown as { BATCH_LINE_ROWS?: symbol }).BATCH_LINE_ROWS ?? Symbol('no line rows');
import type { GateConfig, GateEventInfo } from '../src/gate/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate');

function tmpPath(name: string): string {
  return join(TMP_DIR, name);
}

function writeConfig(name: string, config: GateConfig): string {
  const path = tmpPath(name);
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

interface TraceEntry {
  type: string;
  [key: string]: unknown;
}

function makeGate(configPath: string, opts?: {
  initialConfig?: GateConfig;
  resolveRouteChannel?: (info: GateEventInfo) => string | undefined;
  privilegedUsersPath?: string;
  isAnswered?: (after: WritePlacement) => boolean;
  agentNames?: string[];
}) {
  const traces: TraceEntry[] = [];
  const messages: Array<{ participant: string; content: unknown; metadata?: unknown }> = [];
  const inferenceRequests: Array<{ agentName: string; reason: string; source: string; channelId?: string; counterparty?: string; addressed?: boolean; at?: number; routeChannelId?: string; routeServerId?: string; batchChannels?: Array<{ channelId: string; serverId?: string }>; writes?: WakeWrite[] }> = [];

  const gate = new EventGate({
    configPath,
    initialConfig: opts?.initialConfig,
    ...(opts?.resolveRouteChannel ? { resolveRouteChannel: opts.resolveRouteChannel } : {}),
    ...(opts?.privilegedUsersPath ? { privilegedUsersPath: opts.privilegedUsersPath } : {}),
    ...(opts?.isAnswered ? { isAnswered: opts.isAnswered } : {}),
    emitTrace: (e) => traces.push(e as TraceEntry),
    addMessage: (p, c, m, _forAgent, placement) => {
      messages.push({ participant: p, content: c, metadata: m });
      if (placement) Object.assign(placement, { agent: 'agent', messageId: `line-${messages.length}` });
      return '';
    },
    requestInference: (a, r, s, p) => inferenceRequests.push({ agentName: a, reason: r, source: s, ...(p ?? {}) }),
    getAgentNames: () => opts?.agentNames ?? ['agent'],
  });

  return { gate, traces, messages, inferenceRequests };
}

function event(overrides?: Partial<GateEventInfo>): GateEventInfo {
  return {
    content: 'test message',
    eventType: 'mcpl:push-event',
    serverId: '',
    channelId: '',
    ...overrides,
  };
}

function arriving(at: number, evaluate: () => void): void {
  const realNow = Date.now;
  Date.now = () => at;
  try {
    evaluate();
  } finally {
    Date.now = realNow;
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Default behavior (no config file)
// ---------------------------------------------------------------------------

describe('default behavior', () => {
  it('no config file + no initial config → all-pass', () => {
    const { gate } = makeGate(tmpPath('nonexistent.json'));
    const decision = gate.evaluate(event());
    assert.strictEqual(decision.trigger, true);
    assert.strictEqual(decision.policyName, null);
  });

  it('default: skip → all skipped', () => {
    const path = writeConfig('skip-default.json', {
      policies: [],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    const decision = gate.evaluate(event());
    assert.strictEqual(decision.trigger, false);
  });
});

// ---------------------------------------------------------------------------
// Policy matching
// ---------------------------------------------------------------------------

describe('policy matching', () => {
  it('scope match — matching event type', () => {
    const path = writeConfig('scope.json', {
      policies: [
        { name: 'channels', match: { scope: ['mcpl:channel-incoming'] }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ eventType: 'mcpl:channel-incoming' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ eventType: 'mcpl:push-event' })).trigger, false);
  });

  it('source match — exact serverId', () => {
    const path = writeConfig('source.json', {
      policies: [
        { name: 'zulip', match: { source: 'zulip' }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ serverId: 'zulip' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ serverId: 'discord' })).trigger, false);
  });

  it('source match — glob pattern', () => {
    const path = writeConfig('source-glob.json', {
      policies: [
        { name: 'any-zulip', match: { source: 'zulip-*' }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ serverId: 'zulip-prod' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ serverId: 'zulip-staging' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ serverId: 'discord' })).trigger, false);
  });

  it('channel match — glob pattern', () => {
    const path = writeConfig('channel-glob.json', {
      policies: [
        { name: 'dev-channels', match: { channel: 'dev-*' }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ channelId: 'dev-backend' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ channelId: 'prod-alerts' })).trigger, false);
  });

  it('mount match — exact name', () => {
    const path = writeConfig('mount-exact.json', {
      policies: [
        {
          name: 'tickets',
          match: { scope: ['workspace:created'], mount: 'knowledge-requests' },
          behavior: 'always',
        },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:created', mount: 'knowledge-requests', paths: ['knowledge-requests/t1.md'] })).trigger,
      true,
    );
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:created', mount: 'library-mined', paths: ['library-mined/r1.md'] })).trigger,
      false,
    );
    // Event without a mount must not match a mount-scoped policy.
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:created' })).trigger,
      false,
    );
  });

  it('pathGlob match — any path matches', () => {
    const path = writeConfig('path-glob.json', {
      policies: [
        {
          name: 'md-only',
          match: { scope: ['workspace:modified'], pathGlob: '*.md' },
          behavior: 'always',
        },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:modified', paths: ['tickets/a.md'] })).trigger,
      true,
    );
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:modified', paths: ['logs/a.txt'] })).trigger,
      false,
    );
    // ANY-match: one matching path is enough.
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:modified', paths: ['logs/a.txt', 'tickets/b.md'] })).trigger,
      true,
    );
    // Empty paths can't match a pathGlob policy.
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:modified', paths: [] })).trigger,
      false,
    );
  });

  it('content filter — text match (case insensitive)', () => {
    const path = writeConfig('filter-text.json', {
      policies: [
        { name: 'errors', match: { filter: { type: 'text', pattern: 'ERROR' } }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ content: 'Something error happened' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ content: 'All good' })).trigger, false);
  });

  it('content filter — regex match', () => {
    const path = writeConfig('filter-regex.json', {
      policies: [
        { name: 'deploys', match: { filter: { type: 'regex', pattern: 'deploy|rollback' } }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ content: 'Starting deploy v2.3' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ content: 'rollback initiated' })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ content: 'Rolling back' })).trigger, false);
  });

  it('combined match — scope + source + filter (AND logic)', () => {
    const path = writeConfig('combined.json', {
      policies: [
        {
          name: 'zulip-errors',
          match: {
            scope: ['mcpl:channel-incoming'],
            source: 'zulip',
            filter: { type: 'text', pattern: 'error' },
          },
          behavior: 'always',
        },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    // All conditions met
    assert.strictEqual(gate.evaluate(event({
      content: 'An error occurred',
      eventType: 'mcpl:channel-incoming',
      serverId: 'zulip',
    })).trigger, true);
    // Wrong scope
    assert.strictEqual(gate.evaluate(event({
      content: 'An error occurred',
      eventType: 'mcpl:push-event',
      serverId: 'zulip',
    })).trigger, false);
    // Wrong source
    assert.strictEqual(gate.evaluate(event({
      content: 'An error occurred',
      eventType: 'mcpl:channel-incoming',
      serverId: 'discord',
    })).trigger, false);
    // No error keyword
    assert.strictEqual(gate.evaluate(event({
      content: 'All good',
      eventType: 'mcpl:channel-incoming',
      serverId: 'zulip',
    })).trigger, false);
  });

  it('first match wins — order matters', () => {
    const path = writeConfig('order.json', {
      policies: [
        { name: 'suppress-noise', match: { filter: { type: 'text', pattern: 'heartbeat' } }, behavior: 'skip' },
        { name: 'catch-all', match: {}, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ content: 'heartbeat ping' })).trigger, false);
    assert.strictEqual(gate.evaluate(event({ content: 'real message' })).trigger, true);
  });

  it('empty match object matches everything', () => {
    const path = writeConfig('empty-match.json', {
      policies: [
        { name: 'catch-all', match: {}, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    assert.strictEqual(gate.evaluate(event({ serverId: 'any', channelId: 'any' })).trigger, true);
  });
});

// ---------------------------------------------------------------------------
// Behaviors
// ---------------------------------------------------------------------------

describe('behaviors', () => {
  it('always → trigger: true', () => {
    const path = writeConfig('always.json', {
      policies: [{ name: 'all', match: {}, behavior: 'always' }],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    const d = gate.evaluate(event());
    assert.strictEqual(d.trigger, true);
    assert.strictEqual(d.behavior, 'always');
  });

  it('skip → trigger: false', () => {
    const path = writeConfig('skip.json', {
      policies: [{ name: 'quiet', match: {}, behavior: 'skip' }],
      default: 'always',
    });
    const { gate } = makeGate(path);
    const d = gate.evaluate(event());
    assert.strictEqual(d.trigger, false);
    assert.strictEqual(d.behavior, 'skip');
    assert.strictEqual(d.policyName, 'quiet');
  });
});

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe('debounce', () => {
  it('returns false immediately', () => {
    const path = writeConfig('debounce.json', {
      policies: [
        { name: 'editor', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    const d = gate.evaluate(event());
    assert.strictEqual(d.trigger, false);
    assert.deepStrictEqual(d.behavior, { debounce: 100 });
  });

  it('batches events and fires after delay', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-fire.json', {
      policies: [
        { name: 'editor', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 150 } },
      ],
      default: 'skip',
    });
    const { gate, messages, inferenceRequests } = makeGate(path);

    gate.evaluate(event({ content: 'edit 1' }));
    gate.evaluate(event({ content: 'edit 2' }));
    gate.evaluate(event({ content: 'edit 3' }));

    // Should not have delivered yet
    assert.strictEqual(inferenceRequests.length, 0);

    // Wait for debounce to fire
    t.mock.timers.tick(200);

    assert.strictEqual(messages.length, 0, 'events stored at arrival get no line');
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].agentName, 'agent');
  });

  it('a quoted event\'s content is cut where no surrogate pair is halved', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-pair.json', {
      policies: [
        { name: 'files', match: { scope: ['workspace:file-changed'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, messages } = makeGate(path);

    // 199 units, then an emoji whose two units straddle the 200-unit cut.
    gate.evaluate(event({ eventType: 'workspace:file-changed', content: `${'a'.repeat(199)}😀 and on` }));
    t.mock.timers.tick(100);

    assert.strictEqual(messages.length, 1);
    const text = (messages[0].content as Array<{ text: string }>)[0].text;
    assert.ok(text.includes(`: ${'a'.repeat(199)}...`), `the cut leaves the emoji out whole: ${JSON.stringify(text)}`);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text), 'no half of a pair');
  });

  it('a batched wake carries the newest channel event\'s channel AND author together (provenance)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-provenance.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path);

    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:alice-room', content: 'a',
      metadata: { author: { id: '111', name: 'alice' } } }));
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:bob-room', content: 'b',
      metadata: { authorId: '222' } }));
    t.mock.timers.tick(150);

    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].reason, 'gate:debounce');
    assert.strictEqual(inferenceRequests[0].channelId, 'discord:g:bob-room', 'newest channel event wins when none is addressed');
    assert.strictEqual(inferenceRequests[0].counterparty, 'discord:user:222', 'author comes from the SAME event as the channel');
    assert.strictEqual(inferenceRequests[0].addressed, undefined);
  });

  it('an older ADDRESSED event outranks newer ambient chatter — channel, author and addressed stay together', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-addressed.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path);
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:alice-room', content: 'hey agent',
      tags: ['chat:addressed'], metadata: { author: { id: '111' } } }));
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:bob-room', content: 'ambient',
      metadata: { authorId: '222' } }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].channelId, 'discord:g:alice-room');
    assert.strictEqual(inferenceRequests[0].counterparty, 'discord:user:111');
    assert.strictEqual(inferenceRequests[0].addressed, true);
  });

  it('the counterparty is namespaced by the event\'s server id, not the channel id\'s first segment', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-namespace.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path);
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'beta', channelId: 'shared', content: 'x',
      metadata: { authorId: '42' } }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests[0].channelId, 'shared');
    assert.strictEqual(inferenceRequests[0].counterparty, 'beta:user:42');
    assert.ok(typeof inferenceRequests[0].at === 'number', 'provenance carries the chosen event\'s timestamp');
  });

  it('a push-event wake (raw adapter channel id) names its author but reports no channel', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-push-raw.json', {
      policies: [
        { name: 'all', match: { scope: ['mcpl:push-event', 'mcpl:channel-incoming'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path);
    // exactly what PushHandler builds for a discord-mcpl DM push event
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'discord', channelId: '123456789012345678', content: 'hi',
      tags: ['chat:dm', 'chat:addressed', 'chat:private'], metadata: { authorId: '42', channelId: '123456789012345678' } }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].channelId, undefined, 'a raw snowflake is not a composite channel id — not reported');
    assert.strictEqual(inferenceRequests[0].counterparty, 'discord:user:42');
    assert.strictEqual(inferenceRequests[0].addressed, true);
  });

  it('an addressed batch names its registered route channel; an ambient batch names none, and names the channel it came from', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-route.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    // The host maps a push origin to its registered composite id.
    const resolveRouteChannel = (info: GateEventInfo) =>
      info.eventType === 'mcpl:push-event' ? `discord:dm:${String(info.metadata?.channelId)}` : info.channelId;
    const { gate, inferenceRequests } = makeGate(path, { resolveRouteChannel });

    // DM (addressed, raw id) then newer ambient chatter elsewhere.
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'discord', channelId: '1548', content: 'dm',
      tags: ['chat:dm', 'chat:addressed'], metadata: { authorId: '42', channelId: '1548' } }));
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:general', content: 'chatter',
      metadata: { authorId: '7' } }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].routeChannelId, 'discord:dm:1548', 'the addressed event names the route');
    assert.strictEqual(inferenceRequests[0].routeServerId, 'discord', "and the route's server, since ids are unique only per server");
    assert.strictEqual(inferenceRequests[0].counterparty, 'discord:user:42', 'route and author come from the same event');
    assert.strictEqual(inferenceRequests[0].channelId, undefined, 'telemetry channel unchanged for push events');

    // Ambient-only batch: telemetry provenance, no route, and the channel it
    // came from, for the notice its reply gets.
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: 'x',
      metadata: { authorId: '8' } }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 2);
    assert.strictEqual(inferenceRequests[1].channelId, 'discord:g:room');
    assert.strictEqual(inferenceRequests[1].routeChannelId, undefined, 'ambient chatter never sets a route');
    assert.strictEqual(inferenceRequests[1].routeServerId, undefined, 'nor its server');
    assert.deepStrictEqual(inferenceRequests[1].batchChannels, [{ channelId: 'discord:g:room', serverId: 'discord' }],
      'it names the channel it came from');
  });

  it('the default resolver routes an addressed channel-incoming event; a push event needs the host resolver', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-route-default.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path);
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: '@agent hi',
      tags: ['chat:addressed'], metadata: { authorId: '1' } }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests[0].routeChannelId, 'discord:g:room');

    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'discord', channelId: '1548', content: 'dm',
      tags: ['chat:dm', 'chat:addressed'], metadata: { authorId: '42', channelId: '1548' } }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests[1].routeChannelId, undefined, 'a raw id is never used as a route');
  });

  it('the newest addressed event decides the route even when it has none (no guessing an older one)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-route-newest.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path); // default resolver: push → no route
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: '@agent first',
      tags: ['chat:addressed'], metadata: { authorId: '1' } }));
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'discord', channelId: '1548', content: 'dm later',
      tags: ['chat:dm', 'chat:addressed'], metadata: { authorId: '42', channelId: '1548' } }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests[0].counterparty, 'discord:user:42');
    assert.strictEqual(inferenceRequests[0].routeChannelId, undefined,
      'the DM is the newest addressed event; replying to the older mention would answer the wrong person');
  });

  it('an addressed push that names only its registered channel (no raw id, no author) still routes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-route-only.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const resolveRouteChannel = (info: GateEventInfo) =>
      typeof info.metadata?.mcplChannelId === 'string' ? info.metadata.mcplChannelId : undefined;
    const { gate, inferenceRequests } = makeGate(path, { resolveRouteChannel });
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'surface', channelId: 'surface:room:general',
      content: 'chatter', metadata: { authorId: '7' } }));
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'surface', content: 'dm',
      tags: ['chat:dm', 'chat:addressed'], metadata: { mcplChannelId: 'surface:dm:42' } }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].routeChannelId, 'surface:dm:42');
    assert.strictEqual(inferenceRequests[0].addressed, true);
    assert.strictEqual(inferenceRequests[0].counterparty, undefined, 'no author on the chosen event, none borrowed from the chatter');
  });

  it('a newer AMBIENT route-only push does not hide an earlier event\'s channel and author', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-route-only-ambient.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const resolveRouteChannel = (info: GateEventInfo) =>
      typeof info.metadata?.mcplChannelId === 'string' ? info.metadata.mcplChannelId : info.channelId || undefined;
    const { gate, inferenceRequests } = makeGate(path, { resolveRouteChannel });
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'surface', channelId: 'surface:room:general',
      content: 'chatter', metadata: { authorId: '7' } }));
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'surface', content: 'status ping',
      metadata: { mcplChannelId: 'surface:room:feed' } }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].channelId, 'surface:room:general', 'telemetry keeps the attributable event');
    assert.strictEqual(inferenceRequests[0].counterparty, 'surface:user:7');
    assert.strictEqual(inferenceRequests[0].routeChannelId, undefined, 'an ambient batch from two channels has no route');
    assert.deepStrictEqual(inferenceRequests[0].batchChannels, [
      { channelId: 'surface:room:general', serverId: 'surface' },
      { channelId: 'surface:room:feed', serverId: 'surface' },
    ], 'and names both channels, for the notice its reply gets');
  });

  it('a batch with an addressed event names no channels, even when that event names none', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-addressed-nowhere.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const resolveRouteChannel = (info: GateEventInfo) =>
      typeof info.metadata?.mcplChannelId === 'string' ? info.metadata.mcplChannelId : info.channelId || undefined;
    const { gate, inferenceRequests } = makeGate(path, { resolveRouteChannel });
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'surface', channelId: 'surface:room:general',
      content: 'chatter', metadata: { authorId: '7' } }));
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'surface', content: 'for you', tags: ['chat:addressed'] }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].routeChannelId, undefined, "the addressed message's reply isn't sent into the chatter's channel");
    assert.strictEqual(inferenceRequests[0].batchChannels, undefined, "nor is it told the chatter's channel was where it came from");
  });

  it('an addressed chat:system notice takes no part in its batch\'s provenance, but for its author when nothing else names one', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-route-dm-notice.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path, { resolveRouteChannel: (info) => info.channelId || undefined });
    const pin = () => gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:dm:5',
      content: '[pinned a message]', tags: ['chat:dm', 'chat:addressed', 'chat:system'], metadata: { authorId: '5' } }));
    arriving(100, () => gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room',
      content: '@agent hi', tags: ['chat:mention', 'chat:addressed'], metadata: { authorId: '1' } })));
    arriving(200, pin);
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].routeChannelId, 'discord:g:room', "the mention's channel: a pin in a DM is still a notice");
    assert.strictEqual(inferenceRequests[0].addressed, true, 'addressed by the mention');
    assert.strictEqual(inferenceRequests[0].channelId, 'discord:g:room');
    assert.strictEqual(inferenceRequests[0].counterparty, 'discord:user:1');
    assert.strictEqual(inferenceRequests[0].at, 100, "the mention's arrival, not the newer pin's");

    arriving(400, () => gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room',
      content: 'chatter', metadata: { authorId: '7' } })));
    arriving(500, pin);
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 2);
    assert.strictEqual(inferenceRequests[1].routeChannelId, undefined, "an addressed notice takes no route, and makes no batch addressed");
    assert.strictEqual(inferenceRequests[1].addressed, undefined);
    assert.deepStrictEqual(inferenceRequests[1].batchChannels, [{ channelId: 'discord:g:room', serverId: 'discord' }]);
    assert.strictEqual(inferenceRequests[1].at, 400, "the chatter's arrival, not the newer pin's");
    assert.strictEqual(inferenceRequests[1].counterparty, 'discord:user:7', "the chatter's author, not the pin's");
    assert.strictEqual(inferenceRequests[1].channelId, 'discord:g:room');

    arriving(1_000, () => gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room',
      content: 'pat joined', tags: ['chat:system'], metadata: { authorId: '6' } })));
    arriving(2_000, pin);
    arriving(3_000, () => gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room',
      content: 'the weather turned', tags: ['chat:system'] })));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 3);
    const alone = inferenceRequests[2];
    assert.deepStrictEqual(
      [alone.channelId, alone.routeChannelId, alone.addressed, alone.batchChannels, alone.counterparty, alone.at],
      [undefined, undefined, undefined, undefined, 'discord:user:5', 2_000],
      "notices alone give the newest author among them, and that notice's arrival time, and nothing else",
    );
  });

  it("a push the host can't place is passed over when a batch names its channels", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-route-unplaced.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const resolveRouteChannel = (info: GateEventInfo) =>
      info.eventType === 'mcpl:channel-incoming' ? info.channelId || undefined : undefined;
    const { gate, inferenceRequests } = makeGate(path, { resolveRouteChannel });
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'discord', channelId: '1548', content: 'status',
      metadata: { channelId: '1548' } }));
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room',
      content: 'chatter', metadata: { authorId: '7' } }));
    const batch = (gate as unknown as { debounceTimers: Map<string, { events: unknown[] }> }).debounceTimers.get('chat');
    assert.strictEqual(batch?.events.length, 2, 'premise: the push is in the batch');
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].routeChannelId, undefined);
    assert.deepStrictEqual(inferenceRequests[0].batchChannels, [{ channelId: 'discord:g:room', serverId: 'discord' }]);
  });

  it("a batch of notices alone gives its newest authored notice's author and time", () => {
    const notice = (timestamp: number, authorId?: string) => ({ policyName: 'chat', content: 'x', eventType: 'mcpl:channel-incoming',
      timestamp, addressed: false, systemNotice: true, serverId: 'discord', channelId: 'discord:g:room', routeChannelId: 'discord:g:room',
      ...(authorId ? { authorId } : {}) });
    const provenance = wakeProvenance([notice(10, '5'), notice(20)] as Parameters<typeof wakeProvenance>[0]);
    assert.deepStrictEqual(provenance, { counterparty: 'discord:user:5', at: 10 });
  });

  it("a batch lists a channel once with its server and once without, since only the host can tell they're one", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-server-and-none.json', {
      policies: [{ name: 'push', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 100 } }],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path, { resolveRouteChannel: () => 'discord:g:room' });
    for (const serverId of ['discord', '', 'discord', '']) {
      gate.evaluate(event({ eventType: 'mcpl:push-event', serverId, content: 'status' }));
    }
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.deepStrictEqual(inferenceRequests[0].batchChannels, [{ channelId: 'discord:g:room', serverId: 'discord' }, { channelId: 'discord:g:room' }]);
  });

  it('an ambient batch of pushes that name only their registered channel names that channel', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-route-only-pushes.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const resolveRouteChannel = (info: GateEventInfo) =>
      typeof info.metadata?.mcplChannelId === 'string' ? info.metadata.mcplChannelId : undefined;
    const { gate, inferenceRequests } = makeGate(path, { resolveRouteChannel });
    for (const content of ['status ping', 'status pong']) {
      gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'surface', content, metadata: { mcplChannelId: 'surface:room:feed' } }));
    }
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].routeChannelId, undefined);
    assert.deepStrictEqual(inferenceRequests[0].batchChannels, [{ channelId: 'surface:room:feed', serverId: 'surface' }]);
    assert.strictEqual(inferenceRequests[0].counterparty, undefined, 'no author to name');
    assert.strictEqual(inferenceRequests[0].at, undefined, 'no chosen event, so no time');
  });

  it('a throwing route resolver never breaks gating', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-route-throw.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path, { resolveRouteChannel: () => { throw new Error('boom'); } });
    const decision = gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room',
      content: '@agent hi', tags: ['chat:addressed'] }));
    assert.strictEqual(decision.policyName, 'chat');
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].routeChannelId, undefined);
  });

  it('a batched wake with no channel-bearing event carries no provenance', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-noprov.json', {
      policies: [
        { name: 'editor', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path);
    gate.evaluate(event({ content: 'edit' }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].channelId, undefined);
    assert.strictEqual(inferenceRequests[0].counterparty, undefined);
  });

  it('quotes content for non-MCPL events (no context entry of their own)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-quote.json', {
      policies: [
        { name: 'editor', match: { scope: ['module:custom'] }, behavior: { debounce: 150 } },
      ],
      default: 'skip',
    });
    const { gate, messages } = makeGate(path);

    gate.evaluate(event({ content: 'compile finished', eventType: 'module:custom' }));
    t.mock.timers.tick(200);

    assert.strictEqual(messages.length, 1);
    const text = (messages[0].content as Array<{ text: string }>)[0].text;
    assert.ok(text.includes('[editor]'));
    assert.ok(text.includes('compile finished'), 'non-MCPL events carry their content');
  });

  it('resets timer on new events', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('debounce-reset.json', {
      policies: [
        { name: 'editor', match: {}, behavior: { debounce: 150 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path);

    gate.evaluate(event({ content: 'edit 1' }));
    t.mock.timers.tick(80);
    // Timer hasn't fired yet, send another
    gate.evaluate(event({ content: 'edit 2' }));
    t.mock.timers.tick(80);
    // Still within debounce window of second event
    assert.strictEqual(inferenceRequests.length, 0);

    t.mock.timers.tick(100);
    // Now it should have fired
    assert.strictEqual(inferenceRequests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Debounce bounds validation
// ---------------------------------------------------------------------------

describe('debounce bounds', () => {
  // A gate.json debounce outside the range is read at its nearest bound, with
  // a note, where the whole file used to be refused; addPolicy still refuses
  // one (event-gate-strict-rules).
  it('reads a debounce < 100ms as 100ms', (t) => {
    t.mock.method(console, 'error', () => {});
    const path = tmpPath('low-debounce.json');
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({
      policies: [{ name: 'fast', match: {}, behavior: { debounce: 50 } }],
      default: 'always',
    }));
    const { gate, traces } = makeGate(path);
    t.after(() => gate.dispose());
    assert.strictEqual(gate.evaluate(event()).trigger, false, 'the event waits in the debounce batch');
    assert.deepStrictEqual(gate.getStatus().policies[0]!.behavior, { debounce: 100 });
    assert.ok(!traces.some(t => t.type === 'gate:config-error'));
  });

  it('reads a debounce > 300000ms as 300000ms', (t) => {
    t.mock.method(console, 'error', () => {});
    const path = tmpPath('high-debounce.json');
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({
      policies: [{ name: 'slow', match: {}, behavior: { debounce: 500000 } }],
      default: 'always',
    }));
    const { gate, traces } = makeGate(path);
    t.after(() => gate.dispose());
    assert.strictEqual(gate.evaluate(event()).trigger, false, 'the event waits in the debounce batch');
    assert.deepStrictEqual(gate.getStatus().policies[0]!.behavior, { debounce: 300000 });
    assert.ok(!traces.some(t => t.type === 'gate:config-error'));
  });
});

// ---------------------------------------------------------------------------
// Inference buffering
// ---------------------------------------------------------------------------

describe('inference buffering', () => {
  it("a flood while the agent's turn runs holds a bounded backlog, dropping its oldest events", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const path = writeConfig('infer-cap.json', {
      policies: [
        { name: 'chat', match: {}, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, messages } = makeGate(path);
    gate.onInferenceStarted('agent');

    const flood = (first: number, batches: number) => {
      for (let batch = first; batch < first + batches; batch++) {
        for (let i = 0; i < 20; i++) {
          gate.evaluate(event({ eventType: 'module:custom', content: `batch${batch}-msg${i}` }));
        }
        t.mock.timers.tick(1_000);
      }
    };
    flood(0, 6);
    const afterSix = gate.inferenceDiagnostics().bufferedEvents;
    assert.ok(afterSix > 0, 'Expected buffer to have events');
    flood(6, 6);
    assert.strictEqual(gate.inferenceDiagnostics().bufferedEvents, afterSix, 'the backlog stops growing');

    // End inference → flush
    gate.onInferenceEnded('agent');
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(messages.length, 1);
    const text = (messages[0]!.content as Array<{ text: string }>)[0]!.text;
    const quoted = text.split('\n').filter((row) => row.startsWith('- [')).map((row) => row.slice(row.lastIndexOf(': ') + 2));
    const sent = Array.from({ length: 12 * 20 }, (_, n) => `batch${Math.floor(n / 20)}-msg${n % 20}`);
    assert.deepStrictEqual(quoted, sent.slice(-afterSix), 'the line quotes the newest events the backlog kept: the oldest are the ones dropped');
    gate.dispose();
  });

  it('debounce during inference → buffer → flush on end', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('infer-debounce.json', {
      policies: [
        { name: 'chat', match: {}, behavior: { debounce: 150 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path);

    gate.evaluate(event({ content: 'msg 1' }));
    gate.evaluate(event({ content: 'msg 2' }));

    // Simulate inference started before debounce fires
    gate.onInferenceStarted('agent');

    // Wait for debounce timer to fire
    t.mock.timers.tick(200);

    // Should be buffered, not delivered (inference is active)
    assert.strictEqual(inferenceRequests.length, 0);

    // End inference → flush
    gate.onInferenceEnded('agent');

    // queueMicrotask defers delivery
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(inferenceRequests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Config hot-reload
// ---------------------------------------------------------------------------

describe('config hot-reload', () => {
  it('reloads config when file changes', async () => {
    const path = writeConfig('reload.json', {
      policies: [{ name: 'all', match: {}, behavior: 'always' }],
      default: 'skip',
    });
    const { gate } = makeGate(path);

    assert.strictEqual(gate.evaluate(event()).trigger, true);

    // Force throttle to expire; the gate compares gate.json's text, whatever its mtime
    (gate as any).lastReloadCheck = 0;

    // Rewrite config — now skip everything
    writeFileSync(path, JSON.stringify({ policies: [], default: 'skip' }));

    assert.strictEqual(gate.evaluate(event()).trigger, false);
  });

  it('config error keeps previous valid config', async () => {
    const path = writeConfig('error-reload.json', {
      policies: [{ name: 'all', match: {}, behavior: 'always' }],
      default: 'skip',
    });
    const { gate, traces } = makeGate(path);
    assert.strictEqual(gate.evaluate(event()).trigger, true);

    // Force throttle to expire
    (gate as any).lastReloadCheck = 0;

    // Write invalid JSON
    writeFileSync(path, 'not valid json{{{');

    // Should still use previous config
    assert.strictEqual(gate.evaluate(event()).trigger, true);
    assert.ok(traces.some(t => t.type === 'gate:config-error'));
  });
});

// ---------------------------------------------------------------------------
// Config seeding
// ---------------------------------------------------------------------------

describe('config seeding', () => {
  it('seeds config file from initialConfig when file does not exist', () => {
    const path = tmpPath('seeded.json');
    const config: GateConfig = {
      policies: [{ name: 'test', match: {}, behavior: 'always' }],
      default: 'skip',
    };
    makeGate(path, { initialConfig: config });

    assert.ok(existsSync(path));
    const written = JSON.parse(readFileSync(path, 'utf-8'));
    assert.strictEqual(written.policies[0].name, 'test');
  });

  it('does not overwrite existing file', () => {
    const path = writeConfig('existing.json', {
      policies: [{ name: 'original', match: {}, behavior: 'always' }],
      default: 'always',
    });

    makeGate(path, {
      initialConfig: {
        policies: [{ name: 'new', match: {}, behavior: 'skip' }],
        default: 'skip',
      },
    });

    const written = JSON.parse(readFileSync(path, 'utf-8'));
    assert.strictEqual(written.policies[0].name, 'original');
  });
});

// ---------------------------------------------------------------------------
// gate:status tool
// ---------------------------------------------------------------------------

describe('gate:status tool', () => {
  it('returns correct status structure', async () => {
    const path = writeConfig('status.json', {
      policies: [
        { name: 'always-policy', match: {}, behavior: 'always' },
        { name: 'debounce-policy', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 1000 } },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);

    // Trigger some matches
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming' }));
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming' }));

    const result = await gate.handleToolCall();
    assert.strictEqual(result.success, true);
    const status = result.data!;
    assert.strictEqual(status.configPath, path);
    assert.strictEqual(status.configSource, 'file');
    assert.strictEqual(status.default, 'skip');
    assert.strictEqual(status.policies.length, 2);
    assert.strictEqual(status.policies[0].name, 'always-policy');
    assert.strictEqual(status.policies[0].matchCount, 2);
    assert.strictEqual(status.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// asShouldTriggerCallback
// ---------------------------------------------------------------------------

describe('asShouldTriggerCallback', () => {
  it('returns a function with the shouldTriggerInference signature', () => {
    const path = writeConfig('callback.json', {
      policies: [
        { name: 'allow-zulip', match: { source: 'zulip' }, behavior: 'always' },
      ],
      default: 'skip',
    });
    const { gate } = makeGate(path);
    const cb = gate.asShouldTriggerCallback();

    assert.strictEqual(typeof cb, 'function');
    assert.strictEqual(cb('hello', { eventType: 'mcpl:push-event', serverId: 'zulip' }), true);
    assert.strictEqual(cb('hello', { eventType: 'mcpl:push-event', serverId: 'discord' }), false);
  });
});

// ---------------------------------------------------------------------------
// Trace events
// ---------------------------------------------------------------------------

describe('trace events', () => {
  it('emits gate:policy-matched on match', () => {
    const path = writeConfig('trace-match.json', {
      policies: [{ name: 'test', match: {}, behavior: 'always' }],
      default: 'skip',
    });
    const { gate, traces } = makeGate(path);
    gate.evaluate(event());

    const matchTraces = traces.filter(t => t.type === 'gate:policy-matched');
    assert.strictEqual(matchTraces.length, 1);
    assert.strictEqual(matchTraces[0].policyName, 'test');
  });

  it('emits gate:config-reloaded on successful reload', async () => {
    const path = writeConfig('trace-reload.json', {
      policies: [],
      default: 'always',
    });
    const { gate, traces } = makeGate(path);
    gate.evaluate(event()); // initial eval

    (gate as any).lastReloadCheck = 0;
    writeFileSync(path, JSON.stringify({ policies: [{ name: 'new', match: {}, behavior: 'skip' }], default: 'always' }));

    gate.evaluate(event());

    assert.ok(traces.some(t => t.type === 'gate:config-reloaded'));
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe('dispose', () => {
  it('clears debounce timers without delivering', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('dispose.json', {
      policies: [{ name: 'debounced', match: {}, behavior: { debounce: 10000 } }],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path);
    gate.evaluate(event());
    gate.dispose();
    t.mock.timers.tick(10_000);

    // No delivery should happen
    assert.strictEqual(inferenceRequests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Policy reconciliation on restart (postmortem: clerk stuck on old policies)
// ---------------------------------------------------------------------------

describe('policy reconciliation', () => {
  it('appends missing-by-name policies from initialConfig when gate.json already exists', () => {
    // Simulate a prior session that seeded gate.json with 2 policies
    const path = writeConfig('reconcile-add.json', {
      default: 'skip',
      policies: [
        { name: 'user-input', match: { scope: ['external-message'] }, behavior: 'always' },
        { name: 'subagent-completions', match: { scope: ['inference-request'] }, behavior: 'always' },
      ],
    });

    // New session starts with a recipe that added a third policy
    const { gate, traces } = makeGate(path, {
      initialConfig: {
        default: 'skip',
        policies: [
          { name: 'user-input', match: { scope: ['external-message'] }, behavior: 'always' },
          { name: 'subagent-completions', match: { scope: ['inference-request'] }, behavior: 'always' },
          { name: 'reviewed-responses', match: { scope: ['workspace:created'] }, behavior: 'always' },
        ],
      },
    });

    // gate.json on disk should now contain all three policies
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    assert.strictEqual(onDisk.policies.length, 3);
    assert.ok(onDisk.policies.some((p: { name: string }) => p.name === 'reviewed-responses'));

    // Reconciliation trace emitted
    assert.ok(traces.some(t => t.type === 'gate:config-reconciled'));

    // Live gate honors the new policy
    assert.strictEqual(
      gate.evaluate(event({ eventType: 'workspace:created' })).trigger,
      true,
    );
  });

  it("leaves existing policies alone — user's workspace--edit survives recipe changes", () => {
    const path = writeConfig('reconcile-preserve.json', {
      default: 'skip',
      policies: [
        {
          name: 'user-input',
          // User edited this policy to also filter on content
          match: { scope: ['external-message'], filter: { type: 'text', pattern: 'urgent' } },
          behavior: 'always',
        },
      ],
    });

    makeGate(path, {
      initialConfig: {
        default: 'skip',
        policies: [
          // Recipe declares it without the filter
          { name: 'user-input', match: { scope: ['external-message'] }, behavior: 'always' },
        ],
      },
    });

    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    assert.strictEqual(onDisk.policies.length, 1);
    assert.deepStrictEqual(onDisk.policies[0].match.filter, { type: 'text', pattern: 'urgent' });
  });
});

// ---------------------------------------------------------------------------
// Observability: defaultDecisions counts help diagnose silent drops
// ---------------------------------------------------------------------------

describe('defaultDecisions counters', () => {
  it('counts events that fell through to default (by eventType)', () => {
    const path = writeConfig('default-counts.json', {
      default: 'skip',
      policies: [
        { name: 'user-input', match: { scope: ['external-message'] }, behavior: 'always' },
      ],
    });
    const { gate } = makeGate(path);

    gate.evaluate(event({ eventType: 'external-message' })); // matches
    gate.evaluate(event({ eventType: 'workspace:created' })); // default skip
    gate.evaluate(event({ eventType: 'workspace:created' })); // default skip
    gate.evaluate(event({ eventType: 'other' })); // default skip

    const status = gate.getStatus();
    assert.strictEqual(status.totalEvaluations, 4);
    assert.strictEqual(status.defaultDecisions.skipped, 3);
    assert.strictEqual(status.defaultDecisions.triggered, 0);
    assert.strictEqual(status.defaultDecisions.byEventType['workspace:created'].skipped, 2);
    assert.strictEqual(status.defaultDecisions.byEventType['other'].skipped, 1);
  });
});

// ---------------------------------------------------------------------------
// Host quiesce suppression (issue #122)
// ---------------------------------------------------------------------------

describe('quiesce suppression', () => {
  it('buffers debounce firings while quiesced and flushes on setQuiesced(false)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('quiesce-debounce.json', {
      policies: [
        { name: 'editor', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 120 } },
      ],
      default: 'skip',
    });
    const { gate, messages, inferenceRequests } = makeGate(path);

    gate.setQuiesced(true);
    gate.evaluate(event({ content: 'edit 1' }));
    gate.evaluate(event({ content: 'edit 2' }));

    // Debounce fires while quiesced → buffered, no context write, no wake.
    t.mock.timers.tick(250);
    assert.strictEqual(messages.length, 0, 'no gate message mid-surgery');
    assert.strictEqual(inferenceRequests.length, 0);
    assert.strictEqual(gate.inferenceDiagnostics().bufferedEvents, 2);

    gate.setQuiesced(false);
    await new Promise((r) => setImmediate(r)); // flush is deferred a microtask
    assert.strictEqual(inferenceRequests.length, 1, 'buffered events compose one delivery');
    assert.strictEqual(gate.inferenceDiagnostics().bufferedEvents, 0);
  });

  it('a turn ending while quiesced does not flush the buffer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const path = writeConfig('quiesce-turn-end.json', {
      policies: [
        { name: 'editor', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 120 } },
      ],
      default: 'skip',
    });
    const { gate, inferenceRequests } = makeGate(path);

    gate.setQuiesced(true);
    gate.onInferenceStarted('agent');
    gate.evaluate(event({ content: 'during drain' }));
    t.mock.timers.tick(250);
    gate.onInferenceEnded('agent'); // drain completes mid-quiesce
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(inferenceRequests.length, 0, 'buffer holds until resume, not turn end');
    assert.strictEqual(gate.inferenceDiagnostics().bufferedEvents, 1);
  });
});

describe('sleep', () => {
  // While asleep, only the agent's own heartbeat and a privileged author
  // rouse it. The heartbeat is the server the host knows as `heartbeat`: a
  // `source` in the metadata is what the server says, and any server says it.
  it('lets through only the server the host names heartbeat, and a privileged author', () => {
    const privileged = tmpPath('privileged.json');
    writeFileSync(privileged, JSON.stringify({ userIds: ['P1'] }));
    const path = writeConfig('sleep.json', { policies: [], default: 'always' });
    const { gate } = makeGate(path, { privilegedUsersPath: privileged });
    gate.setSleep(3600, 'resting', 'agent');
    try {
      const roused = (info: Partial<GateEventInfo>) => gate.evaluate(event(info)).trigger;
      assert.strictEqual(roused({ serverId: 'discord', metadata: {} }), false, 'an ordinary event');
      assert.strictEqual(roused({ serverId: 'discord', metadata: { source: 'heartbeat' } }), false, "another server saying it's the heartbeat");
      assert.strictEqual(roused({ serverId: 'heartbeat', metadata: { source: 'heartbeat' } }), true, 'the heartbeat');
      assert.strictEqual(roused({ serverId: 'heartbeat', metadata: { source: 'reminder' } }), true, "the heartbeat server's reminder");
      assert.strictEqual(roused({ serverId: 'discord', metadata: { author: { id: 'P1' } } }), true, 'a privileged author');
    } finally {
      gate.clearSleep();
    }
  });
});

describe('EventGate: channel patterns and channelId keys through the route resolver (#702)', () => {
  const policies = (channel: string): GateConfig => ({
    policies: [
      { name: 'room', match: { channel }, behavior: 'always' },
      { name: 'rest', match: {}, behavior: 'skip' },
    ],
    default: 'skip',
  });
  const push = (metadata: Record<string, unknown>): GateEventInfo =>
    event({ eventType: 'mcpl:push-event', serverId: 'discord', channelId: typeof metadata.channelId === 'string' ? metadata.channelId : '', metadata });
  const registeredFromOrigin = (info: GateEventInfo): string | undefined =>
    typeof info.metadata?.mcplChannelId === 'string' ? info.metadata.mcplChannelId : undefined;

  it("with the default resolver, a push meets a pattern by its own id alone", () => {
    const { gate } = makeGate(writeConfig('route-default.json', policies('discord:g1:room')));
    assert.strictEqual(gate.evaluate(push({ channelId: 'room', mcplChannelId: 'discord:g1:room' })).policyName, 'rest');
    assert.strictEqual(gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g1:room' })).policyName, 'room');
  });

  it("with a host's resolver, a push meets a pattern by the registered id it resolves", () => {
    const { gate } = makeGate(writeConfig('route-host.json', policies('discord:g1:room')), { resolveRouteChannel: registeredFromOrigin });
    assert.strictEqual(gate.evaluate(push({ channelId: 'room', mcplChannelId: 'discord:g1:room' })).policyName, 'room');
    assert.strictEqual(gate.evaluate(push({ channelId: 'room', mcplChannelId: 'discord:g1:other' })).policyName, 'rest');
  });

  it("a resolver that throws matches nothing through it, and the event's own id still matches", () => {
    const resolveRouteChannel = (): string | undefined => { throw new Error('boom'); };
    const registered = makeGate(writeConfig('route-throw-registered.json', policies('discord:g1:room')), { resolveRouteChannel });
    assert.strictEqual(registered.gate.evaluate(push({ channelId: 'room', mcplChannelId: 'discord:g1:room' })).policyName, 'rest');
    const raw = makeGate(writeConfig('route-throw-raw.json', policies('room')), { resolveRouteChannel });
    assert.strictEqual(raw.gate.evaluate(push({ channelId: 'room' })).policyName, 'room');
  });

  it("keyBy channelId counts by the resolved id, and by metadata.channelId when the resolver gives none", () => {
    const config: GateConfig = {
      policies: [{ name: 'limit', match: {}, behavior: { rate_limit: { tokens: 1, refillIntervalMs: 3_600_000, keyBy: 'channelId' } } }],
      default: 'skip',
    };
    const { gate } = makeGate(writeConfig('route-keyby.json', config), { resolveRouteChannel: registeredFromOrigin });
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g1:room', metadata: { channelId: 'discord:g1:room' } }));
    gate.evaluate(push({ channelId: 'room', mcplChannelId: 'discord:g1:room' }));
    gate.evaluate(push({ channelId: 'side' }));
    gate.evaluate(push({ channelId: 'other' }));
    const state = gate.getStatus().policies.find((p) => p.name === 'limit')?.rateLimitState;
    assert.deepStrictEqual(state, { bucketCount: 3, deniedCount: 1 }, "the room's message and push share one bucket; each unresolved push keys on its own channelId");
  });
});

describe('a batched wake writes no line for events with a message of their own', () => {
  const fire = (gate: EventGate, policyName: string): void => {
    const batch = gate as unknown as {
      debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout> }>;
      fireDebounce(policyName: string): void;
    };
    clearTimeout(batch.debounceTimers.get(policyName)!.timer);
    batch.fireDebounce(policyName);
  };
  const config = (name: string): string => writeConfig(name, {
    policies: [{ name: 'chat', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event', 'workspace:file-changed', 'clock:reminder'] }, behavior: { debounce: 60_000 } }],
    default: 'skip',
  });
  const message = (messageId: string, tags: string[] = ['chat:addressed']) => event({ eventType: 'mcpl:channel-incoming', serverId: 'discord',
    channelId: 'discord:g:room', content: `text of ${messageId}`, metadata: { messageId }, tags });

  it('messages stored at arrival: no line, and every agent\'s wake carries the same writes, each with the channel a reply is owed in', () => {
    const { gate, messages, inferenceRequests } = makeGate(config('in-window.json'), { agentNames: ['scout', 'mira'] });
    const addressed = { agent: 'scout', messageId: 'row-1' };
    const ambient = { agent: 'scout', messageId: 'row-2' };
    gate.evaluate(message('m1'), addressed);
    gate.evaluate(message('m2', ['chat:ambient']), ambient);
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 0, 'no [Gate: …] line');
    assert.deepStrictEqual(inferenceRequests.map((r) => r.agentName), ['scout', 'mira']);
    const writes = inferenceRequests[0].writes!;
    assert.strictEqual(inferenceRequests[1].writes, writes, 'one list for every agent');
    assert.strictEqual(writes.length, 2);
    assert.strictEqual(writes[0]!.after, addressed, 'the write as the host gave it, which it may fill in later');
    assert.deepStrictEqual(writes[0]!.replyTo, { serverId: 'discord', channelId: 'discord:g:room' });
    assert.strictEqual(writes[1]!.after, ambient);
    assert.strictEqual(writes[1]!.replyTo, undefined, 'an ambient message owes no reply');
  });

  it('a folded render given a placement takes no write, so it carries no reply evidence', () => {
    const { gate, messages, inferenceRequests } = makeGate(config('folded-render.json'));
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'discord', channelId: 'discord:g:room', content: 'render',
      metadata: { eventId: 'ev-1', channelId: 'discord:g:room' }, tags: ['chat:system'], folds: true }), { agent: 'scout', messageId: 'row-1' });
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 0, 'premise: a push counts as in the window, so no line');
    assert.strictEqual(inferenceRequests.length, 1, 'premise: it woke');
    assert.strictEqual(inferenceRequests[0].writes, undefined);
  });

  it('a push event stored at arrival: no line', () => {
    const { gate, messages, inferenceRequests } = makeGate(config('push-in-window.json'));
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'discord', channelId: '1548', content: 'dm', metadata: { eventId: 'ev-1' } }),
      { agent: 'agent', messageId: 'row-1' });
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 0);
    assert.strictEqual(inferenceRequests[0].writes?.length, 1);
  });

  it('a module event given its write counts as in the window: no line, and its write is carried', () => {
    const { gate, messages, inferenceRequests } = makeGate(config('module-written.json'));
    const write = { agent: 'agent', messageId: 'row-1' };
    gate.evaluate(event({ eventType: 'clock:reminder', content: 'water the plants' }), write);
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 0);
    assert.strictEqual(inferenceRequests[0].writes?.[0]?.after, write);
  });

  it('an event with no message of its own keeps a line naming it alone, and the wake reads that line beside the other writes', () => {
    const { gate, messages, inferenceRequests } = makeGate(config('mixed.json'));
    gate.evaluate(message('m1'), { agent: 'agent', messageId: 'row-1' });
    gate.evaluate(event({ eventType: 'workspace:file-changed', content: 'notes.md changed' }));
    gate.evaluate(message('m2'), { agent: 'agent', messageId: 'row-2' });
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 1);
    assert.strictEqual((messages[0]!.content as Array<{ text: string }>)[0]!.text,
      '[Gate: 1 event matched]\n\n- [chat] (workspace:file-changed): notes.md changed');
    assert.deepStrictEqual(inferenceRequests[0].writes?.map((w) => w.after.messageId), ['line-1', 'row-1', 'row-2']);
  });

  it('a message the host gave no write: the wake carries no writes, and still no line', () => {
    const { gate, messages, inferenceRequests } = makeGate(config('unwritten.json'));
    gate.evaluate(message('m1'), { agent: 'agent', messageId: 'row-1' });
    gate.evaluate(message('m2'));
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 0);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].writes, undefined);
  });

  it("a placed message beside a push the host gave no write: the wake carries no writes, but its line rows still name the placed message", () => {
    const { gate, messages, inferenceRequests } = makeGate(config('line-rows-unplaced.json'));
    const placed = { agent: 'agent', messageId: 'row-1' };
    gate.evaluate(message('m1'), placed);
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'discord', channelId: '1548', content: 'a coalesced push', metadata: { eventId: 'ev-1' } }));
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 0, 'premise: no line at delivery');
    assert.strictEqual(inferenceRequests[0]!.writes, undefined, 'premise: nothing to drop the wake by');
    assert.deepStrictEqual((inferenceRequests[0] as Record<symbol, unknown>)[BATCH_LINE_ROWS], [placed]);
  });

  it('what the judge is told: a debounced batch whose every event has a write placed for the agent only may wake it', () => {
    const { gate } = makeGate(config('upcoming.json'), { agentNames: ['agent', 'other'] });
    gate.evaluate(message('m1'), { agent: 'agent', messageId: 'row-1' });
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => w.certain), [false]);
    assert.deepStrictEqual(gate.upcomingWakes(['other']).map((w) => w.certain), [true], 'a write placed for another agent drops no wake of this one');
    gate.evaluate(event({ eventType: 'workspace:file-changed', content: 'notes.md changed' }));
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => w.certain), [true], 'a quoted event\'s line is written when the batch is delivered, so no answer before its delivery covers it');
  });

  it('what the judge is told: a write with no stored id drops no wake', () => {
    const { gate } = makeGate(config('upcoming-no-id.json'));
    gate.evaluate(message('m1'), { agent: 'agent' });
    assert.deepStrictEqual(gate.upcomingWakes(['agent']).map((w) => w.certain), [true]);
  });
});
