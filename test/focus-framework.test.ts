/**
 * Focus mode through the framework seams: ingestion on BOTH inbound paths
 * (channels/incoming and push/event — DMs live on the latter), the wake
 * gate's hold (no debounce leak, pre-queued wakes purged), the resident's
 * view exclusion (stored but not compiled), the in-channel autoreply over a
 * real MCPL child, and the end-of-focus dump + wake.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { FocusCoordinator } from '../src/focus/coordinator.js';
import type { EventGate } from '../src/gate/event-gate.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const FOCUS = 'disc:guild:noisy';   // registered by the fixture
const OTHER = 'disc:guild:other';   // registered here, same server, opened
const LURK = 'disc:guild:lurk';     // registered here, never opened

type Stored = { participant: string; content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> };

function internals(framework: AgentFramework) {
  return framework as unknown as {
    focusCoordinator: FocusCoordinator | null;
    eventGate: EventGate | null;
    channelRegistry: ChannelRegistry | null;
    pendingRequests: Array<{ agentName: string; reason: string }>;
    handleMcplChannelIncoming(event: Record<string, unknown>): Promise<void>;
    handleMcplPushEvent(event: Record<string, unknown>): void;
    agents: Map<string, { state: { status: string }; getContextManager(): {
      getAllMessages(): Stored[];
      compile(): Promise<{ messages: Stored[] }>;
    } }>;
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const textOf = (m: Stored): string => m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

describe('focus through the framework', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let statusPath: string;
  let n = 0;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'focus-fw-'));
    statusPath = join(tempDir, 'status.jsonl');
    const commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      focus: { enabled: true, defaultBacklogCap: 2 },
      gate: {
        config: {
          // Debounce windows far beyond any run of this file: a queued wake
          // that SURVIVES the purge (the focus channel's own, asserted below)
          // must never fire mid-test — it would wake scout with no mock
          // response queued, and the harness then spins silently (a wake
          // with no MockMembrane response restart-loops on microtasks and
          // starves the TAP reporter — cf. the harness note atop
          // channel-incoming-targeting.test.ts). A 60 s window hung a slow
          // CI runner exactly that way.
          policies: [
            { name: 'batch-other', match: { channel: OTHER }, behavior: { debounce: 3_600_000 } },
            { name: 'batch-push', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 3_600_000 } },
          ],
          default: 'always',
        },
      },
      mcplServers: [{
        id: 'disc',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    await framework.start();
    await waitFor(
      () => (internals(framework).channelRegistry?.listChannelsRaw().length ?? 0) > 0,
      'channel registration',
    );
    const registry = internals(framework).channelRegistry!;
    registry.ensureChannelRegistered('disc', OTHER, 'other');
    registry.ensureChannelRegistered('disc', LURK, 'lurk');
    // A second server whose channel id STRING equals the focus channel's id.
    registry.ensureChannelRegistered('disc2', FOCUS, 'imposter');
    // The resident is open in OTHER (autoreply may speak there) and not in LURK.
    const opened = await registry.handleChannelToolCall('channel_open', { channelId: OTHER, serverId: 'disc' });
    assert.equal(opened.success, true, JSON.stringify(opened));
  });

  after(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function incoming(channelId: string, text: string, o?: { addressed?: boolean; authorId?: string }): Record<string, unknown> {
    return {
      type: 'mcpl:channel-incoming',
      serverId: 'disc',
      channelId,
      messageId: `m-${++n}`,
      author: { id: o?.authorId ?? 'U1', name: 'antra' },
      content: [{ type: 'text', text }],
      timestamp: new Date().toISOString(),
      metadata: {},
      ...(o?.addressed ? { tags: ['chat:mention', 'chat:addressed'] } : {}),
      triggerInference: true,
    };
  }

  function publishes(): string[] {
    if (!existsSync(statusPath)) return [];
    return readFileSync(statusPath, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; channelId?: string })
      .filter((e) => e.event === 'publish')
      .map((e) => e.channelId!);
  }

  it('exposes the focus tool only when enabled', () => {
    assert.ok(framework.getAllTools().some((t) => t.name === 'focus'));
  });

  it('holds every non-focus channel and DM; gate drops them before debounce; view excludes them; autoreplies once', async () => {
    const i = internals(framework);
    const gate = i.eventGate!;
    const coordinator = i.focusCoordinator!;
    assert.ok(coordinator, 'coordinator exists when focus is enabled + mcpl configured');

    // A wake for OTHER queued in the gate BEFORE focus begins…
    const pre = gate.evaluate({ content: 'pre', eventType: 'mcpl:channel-incoming', serverId: 'disc', channelId: OTHER, metadata: {} });
    assert.equal(pre.policyName, 'batch-other');
    assert.equal(gate.getStatus().policies.find((p) => p.name === 'batch-other')?.debounceState?.pendingCount, 1);

    // ---- enter ---------------------------------------------------------
    // …and a queued mcpl-native PUSH wake for a held channel (channel rides in
    // origin.mcplChannelId, no top-level channelId — the shape the purge used
    // to miss; slimepriestess's probe 1).
    const pushMeta = { serverId: 'disc', featureSet: 'chat', eventId: 'e-pre-1', eventType: 'mcpl:push-event', mcplChannelId: OTHER, tags: ['chat:message'] };
    assert.equal(gate.evaluate({ content: 'queued before focus', eventType: 'mcpl:push-event', serverId: 'disc', channelId: '', metadata: pushMeta, tags: ['chat:message'] }).policyName, 'batch-push');
    // …and a queued push wake for the FOCUS channel itself, which must survive.
    const focusPushMeta = { ...pushMeta, eventId: 'e-pre-2', mcplChannelId: FOCUS };
    gate.evaluate({ content: 'focus channel, queued before focus', eventType: 'mcpl:push-event', serverId: 'disc', channelId: '', metadata: focusPushMeta, tags: ['chat:message'] });
    assert.equal(gate.getStatus().policies.find((p) => p.name === 'batch-push')?.debounceState?.pendingCount, 2);

    const entered = coordinator.handleTool({ mode: 'enter', channelId: FOCUS, serverId: 'disc', durationSeconds: 120 });
    assert.equal(entered.success, true, JSON.stringify(entered));

    // …is purged on enter, and new OTHER events are held at the gate.
    assert.equal(gate.getStatus().policies.find((p) => p.name === 'batch-other')?.debounceState?.pendingCount ?? 0, 0);
    assert.equal(gate.getStatus().policies.find((p) => p.name === 'batch-push')?.debounceState?.pendingCount ?? 0, 1,
      'the held channel\'s push wake is purged; the focus channel\'s survives');
    assert.equal(gate.evaluate({ content: 'same shape after focus', eventType: 'mcpl:push-event', serverId: 'disc', channelId: '', metadata: { ...pushMeta, eventId: 'e-pre-3' }, tags: ['chat:message'] }).policyName,
      'focus-held', 'live evaluation and purge share one derivation');
    // Same id string on another server is NOT the focus channel (probe 2).
    assert.equal(gate.evaluate({ content: 'x', eventType: 'mcpl:channel-incoming', serverId: 'disc2', channelId: FOCUS, metadata: {} }).policyName, 'focus-held');
    const heldDecision = gate.evaluate({ content: 'x', eventType: 'mcpl:channel-incoming', serverId: 'disc', channelId: OTHER, metadata: {} });
    assert.deepEqual([heldDecision.trigger, heldDecision.policyName], [false, 'focus-held']);
    const liveDecision = gate.evaluate({ content: 'x', eventType: 'mcpl:channel-incoming', serverId: 'disc', channelId: FOCUS, metadata: {} });
    assert.equal(liveDecision.trigger, true);
    // A push event whose origin derives to a non-focus channel is held; one with no channel is not.
    const dmDecision = gate.evaluate({
      content: 'dm', eventType: 'mcpl:push-event', serverId: 'disc', channelId: '',
      metadata: { source: 'discord', channelId: '999', guildId: null, isDM: true, authorName: 'bob' },
    });
    assert.equal(dmDecision.policyName, 'focus-held');
    const beat = gate.evaluate({ content: 'tick', eventType: 'mcpl:push-event', serverId: 'heartbeat', channelId: '', metadata: { source: 'heartbeat' } });
    assert.notEqual(beat.policyName, 'focus-held', 'a channel-less push is not held (it falls to the ordinary policies)');

    // ---- ingestion: channels/incoming --------------------------------
    i.pendingRequests.length = 0;
    await i.handleMcplChannelIncoming(incoming(OTHER, 'other 1'));
    await i.handleMcplChannelIncoming(incoming(OTHER, '@scout other 2', { addressed: true, authorId: 'A' }));
    await i.handleMcplChannelIncoming(incoming(OTHER, '@scout other 3', { addressed: true, authorId: 'A' }));
    // A mention in a channel the resident never joined: held, counted, no reply.
    await i.handleMcplChannelIncoming(incoming(LURK, '@scout from lurk', { addressed: true, authorId: 'C' }));
    // Cross-server collision: same id string as the focus channel, other server.
    await i.handleMcplChannelIncoming({ ...incoming(FOCUS, 'hello from the imposter channel', { authorId: 'U9' }), serverId: 'disc2' });
    assert.equal(i.pendingRequests.length, 0, 'held traffic wakes nobody');

    // ---- ingestion: push/event (DM) ----------------------------------
    i.handleMcplPushEvent({
      type: 'mcpl:push-event', serverId: 'disc', featureSet: 'chat', eventId: 'e-dm-1',
      origin: { source: 'discord', channelId: '999', guildId: null, isDM: true, authorId: 'B', authorName: 'bob', messageId: 'pm-1' },
      content: [{ type: 'text', text: 'psst, dm' }],
      tags: ['chat:dm', 'chat:addressed'],
      triggerInference: true,
    });
    assert.equal(i.pendingRequests.length, 0, 'held DM wakes nobody');

    const cm = i.agents.get('scout')!.getContextManager();
    const stored = cm.getAllMessages();
    const heldStored = stored.filter((m) => (m.metadata as { focusHeld?: unknown })?.focusHeld);
    assert.equal(heldStored.length, 6, 'all six held messages are stored (incl. lurk + imposter)');
    assert.ok(heldStored.some((m) => textOf(m).includes('imposter channel')), 'the other server\'s same-id channel is held');
    assert.ok(heldStored.every((m) => (m.metadata as { focusHeld: { epochId: string } }).focusHeld.epochId));
    const compiled = await cm.compile();
    assert.ok(!compiled.messages.some((m) => /other \d|psst|lurk|imposter/.test(textOf(m))), 'held messages never compile');

    // ---- autoreply: once per (channel, author), over the real child --
    await waitFor(() => publishes().length >= 2, 'autoreply publishes');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(publishes().sort(), [OTHER, 'discord:dm:999'].sort(),
      'one reply per channel+author despite two addressed messages from A; none into the never-joined channel');

    // ---- the focus channel still wakes --------------------------------
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'on it' }]));
    await i.handleMcplChannelIncoming(incoming(FOCUS, 'live one'));
    assert.deepEqual(i.pendingRequests.map((r) => r.agentName), ['scout']);
    await waitFor(() => membrane.calls.length >= 1, 'scout turn on the focus channel');
    await waitFor(() => i.agents.get('scout')!.state.status === 'idle', 'scout idle');
    i.pendingRequests.length = 0;
    // ---- check ---------------------------------------------------------
    const check = coordinator.handleTool({ mode: 'check' });
    const data = check.data as { focused: boolean; held: Array<{ serverId: string; channelId: string; messages: number; addressed: number }> };
    assert.equal(data.focused, true);
    assert.deepEqual(data.held.map((h) => [h.serverId, h.channelId, h.messages, h.addressed]).sort(),
      [['disc', OTHER, 3, 2], ['disc', LURK, 1, 1], ['disc2', FOCUS, 1, 0], ['disc', 'discord:dm:999', 1, 1]].sort());
    // ---- end -----------------------------------------------------------
    // The end-of-focus wake runs a real scout turn; MockMembrane needs a
    // response queued or the harness restart-loops the turn.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'back' }]));
    const ended = coordinator.handleTool({ mode: 'end' });
    // Diagnostic guard: if an assertion below fails, `after()` stops the
    // framework mid-turn and the harness microtask-spins, starving the TAP
    // reporter — so the failure would be invisible. Log it synchronously.
    try {
    assert.deepEqual(ended, { success: true, data: { ended: true, held: 6 } });
    assert.deepEqual(i.pendingRequests.map((r) => [r.agentName, r.reason]), [['scout', 'focus ended (ended by you)']]);
    // The dump goes through addMessage, which defers under the turn-alive
    // guard and flushes at the next turn boundary — the wake queued above.
    let dump: Stored | undefined;
    await waitFor(() => Boolean(dump = cm.getAllMessages().find((m) => m.metadata?.kind === 'focus-end')), 'dump delivered');
    const text = textOf(dump!);
    assert.match(text, /6 messages held across 4 channels; 4 addressed you \(2 got the automatic reply\)/);
    assert.match(text, /<focus-backlog channel="#other \(disc:guild:other\)" messages=3 tz="[^"]+" truncated=1 \(oldest, not shown\)>/);
    assert.doesNotMatch(text, /other 1\n/);
    assert.match(text, /other 2\n.*other 3\n<\/focus-backlog>/);
    assert.match(text, /<focus-backlog channel="#DM: bob \(discord:dm:999\)" messages=1 tz="[^"]+">\n\[\d\d:\d\d\] bob: psst, dm\n<\/focus-backlog>/);
    assert.doesNotMatch(text, /Channel invitation/, 'held messages carry no at-arrival invitation');
    assert.match(text, /channel_open \{channelId, backscroll\}/, 'hint names a tool the resident has');
    // The dump compiles; the held originals still do not.
    const after = await cm.compile();
    assert.ok(after.messages.some((m) => textOf(m).includes('<focus-backlog')));
    assert.ok(!after.messages.some((m) => /^other 1$|psst, dm$/m.test(textOf(m)) && !textOf(m).includes('<focus-backlog')));
    assert.equal(gate.evaluate({ content: 'x', eventType: 'mcpl:channel-incoming', serverId: 'disc', channelId: OTHER, metadata: {} }).policyName,
      'batch-other', 'gate hold cleared at end');
    } catch (err) {
      const dumpMsg = cm.getAllMessages().find((m) => m.metadata?.kind === 'focus-end');
      console.error('[t] post-end assertion failed: ' + (err as Error).message + '\n--- dump ---\n' + (dumpMsg ? textOf(dumpMsg) : '(none)') + '\n--- pending ---\n' + JSON.stringify(i.pendingRequests));
      throw err;
    }
    await waitFor(() => membrane.calls.length >= 2, 'scout turn after focus ended');
    await waitFor(() => i.agents.get('scout')!.state.status === 'idle', 'scout idle after end');
  });
});
