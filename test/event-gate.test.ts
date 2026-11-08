import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate, wakeLineText } from '../src/gate/event-gate.js';
import type { GateConfig, GateEntryRef, GateEventInfo, WakeLine } from '../src/gate/types.js';

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
  channelShown?: (channel: { serverId: string; channelId: string }) => string;
  privilegedUsersPath?: string;
  isNewestEntry?: (entry: GateEntryRef) => boolean;
  agentNames?: string[];
}) {
  const traces: TraceEntry[] = [];
  const messages: Array<{ participant: string; content: unknown; metadata?: unknown }> = [];
  const inferenceRequests: Array<{ agentName: string; reason: string; source: string; channelId?: string; counterparty?: string; addressed?: boolean; at?: number; routeChannelId?: string; routeServerId?: string; line?: WakeLine }> = [];

  const gate = new EventGate({
    configPath,
    initialConfig: opts?.initialConfig,
    ...(opts?.resolveRouteChannel ? { resolveRouteChannel: opts.resolveRouteChannel } : {}),
    ...(opts?.channelShown ? { channelShown: opts.channelShown } : {}),
    ...(opts?.privilegedUsersPath ? { privilegedUsersPath: opts.privilegedUsersPath } : {}),
    ...(opts?.isNewestEntry ? { isNewestEntry: opts.isNewestEntry } : {}),
    emitTrace: (e) => traces.push(e as TraceEntry),
    addMessage: (p, c, m) => { messages.push({ participant: p, content: c, metadata: m }); return ''; },
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
    assert.strictEqual(messages.length, 0);

    // Wait for debounce to fire
    t.mock.timers.tick(200);

    assert.strictEqual(messages.length, 1);
    const text = (messages[0].content as Array<{ text: string }>)[0].text;
    assert.ok(text.includes('3 event'));
    // MCPL events (push-event / channel-incoming) are stored in the context
    // window AT ARRIVAL by the framework, so the batched wake references them
    // instead of re-quoting — a re-quote minutes later reads as fresh, stale
    // duplicate input (observed live: Sol's "step was a bit too small" echo).
    assert.ok(text.includes('already shown above'));
    assert.ok(!text.includes('edit 1'), 'must not re-quote in-context event content');
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].agentName, 'agent');
  });

  it('a batched wake names a channel whose channelName already starts with # with one #', () => {
    // #406: a channel's name may carry its own `#`; the line adds one only
    // where the name lacks it, as the other places that add a `#` do.
    const path = writeConfig('debounce-hash-name.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, messages } = makeGate(path);
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'zulip', channelId: 'zulip:design', content: 'a',
      metadata: { channelName: '#design' } }));
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:portables', content: 'b',
      metadata: { channelName: 'portables' } }));
    // Fire the batch now rather than after a delay, so the verdict doesn't
    // depend on how loaded the machine is.
    const batch = gate as unknown as {
      debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout> }>;
      fireDebounce(policyName: string): void;
    };
    clearTimeout(batch.debounceTimers.get('chat')!.timer);
    batch.fireDebounce('chat');

    assert.strictEqual(messages.length, 1);
    const text = (messages[0].content as Array<{ text: string }>)[0].text;
    assert.match(text, /1 message in #design \(zulip:design\)/);
    assert.match(text, /1 message in #portables \(discord:g:portables\)/);
    assert.doesNotMatch(text, /##/);
  });

  it("a batched wake names two servers' channels with one id apart, each with its own count", () => {
    // Channel ids are unique only within one server's connection.
    const path = writeConfig('debounce-shared-id.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, messages } = makeGate(path, { channelShown: (c) => `${c.serverId}:${c.channelId}` });
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'a', channelId: 'general', content: 'one',
      metadata: { channelName: 'general' } }));
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'b', channelId: 'general', content: 'two',
      metadata: { channelName: 'general' } }));
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'b', channelId: 'general', content: 'three',
      metadata: { channelName: 'general' } }));
    const batch = gate as unknown as {
      debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout> }>;
      fireDebounce(policyName: string): void;
    };
    clearTimeout(batch.debounceTimers.get('chat')!.timer);
    batch.fireDebounce('chat');

    const text = (messages[0]!.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /- 1 message in #general \(a:general\)/);
    assert.match(text, /- 2 messages in #general \(b:general\)/);
  });

  it("a batched wake shows a push event's adapter id as it is, and only a registered channel as the registry names it", () => {
    const path = writeConfig('debounce-raw-id.json', {
      policies: [
        { name: 'chat', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] }, behavior: { debounce: 100 } },
      ],
      default: 'skip',
    });
    const { gate, messages } = makeGate(path, { channelShown: (c) => `shown ${c.serverId} ${c.channelId}` });
    // A push event carries the adapter's raw id, which no route maps to a
    // registered channel here; a channel message names its registered one.
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'discord', channelId: '1548', content: 'dm' }));
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: 'hi' }));
    const batch = gate as unknown as {
      debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout> }>;
      fireDebounce(policyName: string): void;
    };
    clearTimeout(batch.debounceTimers.get('chat')!.timer);
    batch.fireDebounce('chat');

    const text = (messages[0]!.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /- 1 message in 1548\b/);
    assert.match(text, /- 1 message in shown discord discord:g:room\b/);
    assert.doesNotMatch(text, /shown discord 1548/, "an adapter's raw id isn't named as a registered channel");
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

  it('an addressed batch names its registered route channel; ambient-only batches name none', async (t) => {
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
    const { gate, inferenceRequests, messages } = makeGate(path, { resolveRouteChannel });

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
    // The batched-wake line names the registered id, not the raw snowflake.
    const text = JSON.stringify(messages.at(-1)?.content);
    assert.ok(text.includes('discord:dm:1548'), 'gate line shows the registered channel id');

    // Ambient-only batch: telemetry provenance, no route.
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: 'x',
      metadata: { authorId: '8' } }));
    t.mock.timers.tick(150);
    assert.strictEqual(inferenceRequests.length, 2);
    assert.strictEqual(inferenceRequests[1].channelId, 'discord:g:room');
    assert.strictEqual(inferenceRequests[1].routeChannelId, undefined, 'ambient chatter never sets a route');
    assert.strictEqual(inferenceRequests[1].routeServerId, undefined, 'nor its server');
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
    assert.strictEqual(inferenceRequests[0].routeChannelId, undefined, 'ambient batches never route');
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
    const { gate, messages } = makeGate(path);

    gate.evaluate(event({ content: 'edit 1' }));
    t.mock.timers.tick(80);
    // Timer hasn't fired yet, send another
    gate.evaluate(event({ content: 'edit 2' }));
    t.mock.timers.tick(80);
    // Still within debounce window of second event
    assert.strictEqual(messages.length, 0);

    t.mock.timers.tick(100);
    // Now it should have fired
    assert.strictEqual(messages.length, 1);
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

    const flood = (batches: number) => {
      for (let batch = 0; batch < batches; batch++) {
        for (let i = 0; i < 20; i++) {
          gate.evaluate(event({ content: `batch${batch}-msg${i}` }));
        }
        t.mock.timers.tick(1_000);
      }
    };
    flood(6);
    const afterSix = gate.inferenceDiagnostics().bufferedEvents;
    assert.ok(afterSix > 0, 'Expected buffer to have events');
    flood(6);
    assert.strictEqual(gate.inferenceDiagnostics().bufferedEvents, afterSix, 'the backlog stops growing');

    // End inference → flush
    gate.onInferenceEnded('agent');
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(messages.length, 1);
    const keptFromSecond = Math.floor((12 * 20 - afterSix) / 20);
    const text = (messages[0]!.content as Array<{ text: string }>)[0]!.text;
    assert.ok(text.includes(`(oldest ~${12 - keptFromSecond}s ago)`), `the oldest events are the ones dropped: ${text}`);
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
    const { gate, messages } = makeGate(path);

    gate.evaluate(event({ content: 'msg 1' }));
    gate.evaluate(event({ content: 'msg 2' }));

    // Simulate inference started before debounce fires
    gate.onInferenceStarted('agent');

    // Wait for debounce timer to fire
    t.mock.timers.tick(200);

    // Should be buffered, not delivered (inference is active)
    assert.strictEqual(messages.length, 0);

    // End inference → flush
    gate.onInferenceEnded('agent');

    // queueMicrotask defers delivery
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(messages.length, 1);
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
    const { gate, messages } = makeGate(path);
    gate.evaluate(event());
    gate.dispose();
    t.mock.timers.tick(10_000);

    // No delivery should happen
    assert.strictEqual(messages.length, 0);
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
    assert.strictEqual(messages.length, 1, 'buffered events compose one delivery');
    assert.strictEqual(inferenceRequests.length, 1);
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
    const { gate, messages } = makeGate(path);

    gate.setQuiesced(true);
    gate.onInferenceStarted('agent');
    gate.evaluate(event({ content: 'during drain' }));
    t.mock.timers.tick(250);
    gate.onInferenceEnded('agent'); // drain completes mid-quiesce
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(messages.length, 0, 'buffer holds until resume, not turn end');
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

/**
 * A batched wake's `[Gate: …]` line says which messages a wake is for. For
 * one message still the newest entry in the window the line would go to, it
 * says nothing the message right above doesn't when the batch fires (the
 * framework answers isNewestEntry), so the gate hands the line to the wake
 * instead of writing it, for a fresh start of the wake's turn to decide
 * (WakeLine). Anything else keeps the line now.
 */
describe('a batched wake writes its line only when it says something', () => {
  const fire = (gate: EventGate, policyName: string): void => {
    const batch = gate as unknown as {
      debounceTimers: Map<string, { timer: ReturnType<typeof setTimeout> }>;
      fireDebounce(policyName: string): void;
    };
    clearTimeout(batch.debounceTimers.get(policyName)!.timer);
    batch.fireDebounce(policyName);
  };
  const config = (name: string): string => writeConfig(name, {
    policies: [{ name: 'chat', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event', 'workspace:file-changed'] }, behavior: { debounce: 60_000 } }],
    default: 'skip',
  });

  it('one batch waking two agents: both wakes carry the same line object, which the framework writes once by its identity', () => {
    const { gate, inferenceRequests } = makeGate(config('quiet-two-agents.json'), { isNewestEntry: () => true, agentNames: ['scout', 'mira'] });
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: 'hi',
      metadata: { messageId: 'm1' }, tags: ['chat:addressed'] }));
    fire(gate, 'chat');
    assert.deepStrictEqual(inferenceRequests.map((r) => r.agentName), ['scout', 'mira']);
    assert.ok(inferenceRequests[0].line, 'premise: the line is handed on');
    assert.strictEqual(inferenceRequests[1].line, inferenceRequests[0].line, 'not a copy per agent');
  });

  it('one channel message, still newest: no line written, the wake runs carrying it, and the framework is asked about that message', async () => {
    const asked: GateEntryRef[] = [];
    const { gate, messages, inferenceRequests, traces } = makeGate(config('quiet-one.json'), {
      isNewestEntry: (entry) => { asked.push(entry); return true; },
    });
    const realNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: 'hi',
        metadata: { messageId: 'm1', channelName: 'room' }, tags: ['chat:addressed'] }));
    } finally {
      Date.now = realNow;
    }
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 0, 'no [Gate: …] line');
    assert.strictEqual(inferenceRequests.length, 1, 'the wake runs');
    assert.deepStrictEqual(asked, [{ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', messageId: 'm1' }]);
    const line = inferenceRequests[0].line;
    assert.ok(line, 'the wake carries the line');
    assert.strictEqual(line.shown, '#room (discord:g:room)', 'the channel as the line names it, its label with its id');
    assert.strictEqual(line.at, 1_000_000, 'its time is the message\'s arrival, not the fire');
    assert.match(wakeLineText(line, line.at + 30_000), /^\[Gate: 1 event matched\]\n\n- 1 message in #room \(discord:g:room\) \(oldest ~30s ago\) — already shown above at arrival/);
    assert.deepStrictEqual(line.entry, asked[0]);
    assert.deepStrictEqual(line.policyNames, ['chat']);
    assert.strictEqual(line.channelId, 'discord:g:room');
    assert.ok(!traces.some((t) => t.type === 'gate:wake-line-omitted'), 'whether it is left out is the turn start\'s to say');
    assert.strictEqual(inferenceRequests[0].channelId, 'discord:g:room', 'its provenance stays');
    assert.strictEqual(inferenceRequests[0].addressed, true);
    assert.strictEqual(inferenceRequests[0].routeChannelId, 'discord:g:room');
  });

  it('one push event, still newest: no line written, the wake carries it, asked by its event id', () => {
    const asked: GateEntryRef[] = [];
    const { gate, messages, inferenceRequests } = makeGate(config('quiet-push.json'), {
      isNewestEntry: (entry) => { asked.push(entry); return true; },
    });
    gate.evaluate(event({ eventType: 'mcpl:push-event', serverId: 'discord', channelId: '1548', content: 'dm',
      metadata: { eventId: 'ev-1' } }));
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 0);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(asked[0].eventId, 'ev-1');
    assert.deepStrictEqual(inferenceRequests[0].line?.entry, asked[0]);
  });

  it('one message with something after it: the line stays', () => {
    const { gate, messages, inferenceRequests } = makeGate(config('quiet-not-newest.json'), { isNewestEntry: () => false });
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: 'hi', metadata: { messageId: 'm1' } }));
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 1);
    assert.match((messages[0].content as Array<{ text: string }>)[0].text, /already shown above/);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0].line, undefined, 'written now, so not handed on');
  });

  it('several messages: the line stays, and the framework is not asked', () => {
    let asked = 0;
    const { gate, messages } = makeGate(config('quiet-several.json'), { isNewestEntry: () => { asked++; return true; } });
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: 'a', metadata: { messageId: 'm1' } }));
    gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: 'b', metadata: { messageId: 'm2' } }));
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 1);
    assert.match((messages[0].content as Array<{ text: string }>)[0].text, /2 messages in/);
    assert.strictEqual(asked, 0);
  });

  it('an event whose content the line quotes (not stored at arrival): the line stays, and the framework is not asked', () => {
    let asked = 0;
    const { gate, messages } = makeGate(config('quiet-quoted.json'), { isNewestEntry: () => { asked++; return true; } });
    gate.evaluate(event({ eventType: 'workspace:file-changed', serverId: '', channelId: '', content: 'notes.md changed' }));
    fire(gate, 'chat');
    assert.strictEqual(messages.length, 1);
    assert.match((messages[0].content as Array<{ text: string }>)[0].text, /notes\.md changed/);
    assert.strictEqual(asked, 0);
  });

  it('a callback that throws keeps the line; without one, every wake writes it, as before', () => {
    const throwing = makeGate(config('quiet-throws.json'), { isNewestEntry: () => { throw new Error('boom'); } });
    throwing.gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: 'hi', metadata: { messageId: 'm1' } }));
    fire(throwing.gate, 'chat');
    assert.strictEqual(throwing.messages.length, 1);
    const plain = makeGate(config('quiet-none.json'));
    plain.gate.evaluate(event({ eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:room', content: 'hi', metadata: { messageId: 'm1' } }));
    fire(plain.gate, 'chat');
    assert.strictEqual(plain.messages.length, 1);
  });
});
