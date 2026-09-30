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
const OTHER = 'disc:guild:other';   // registered here, same server

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

async function waitFor(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
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
          policies: [{ name: 'batch-other', match: { channel: OTHER }, behavior: { debounce: 60_000 } }],
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
    internals(framework).channelRegistry!.ensureChannelRegistered('disc', OTHER, 'other');
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
    const entered = coordinator.handleTool({ mode: 'enter', channelId: FOCUS, durationSeconds: 120 });
    assert.equal(entered.success, true, JSON.stringify(entered));

    // …is purged on enter, and new OTHER events are held at the gate.
    assert.equal(gate.getStatus().policies.find((p) => p.name === 'batch-other')?.debounceState?.pendingCount ?? 0, 0);
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
    assert.equal(beat.trigger, true);

    // ---- ingestion: channels/incoming --------------------------------
    i.pendingRequests.length = 0;
    await i.handleMcplChannelIncoming(incoming(OTHER, 'other 1'));
    await i.handleMcplChannelIncoming(incoming(OTHER, '@scout other 2', { addressed: true, authorId: 'A' }));
    await i.handleMcplChannelIncoming(incoming(OTHER, '@scout other 3', { addressed: true, authorId: 'A' }));
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
    assert.equal(heldStored.length, 4, 'all four held messages are stored');
    assert.ok(heldStored.every((m) => (m.metadata as { focusHeld: { epochId: string } }).focusHeld.epochId));
    const compiled = await cm.compile();
    assert.ok(!compiled.messages.some((m) => /other \d|psst/.test(textOf(m))), 'held messages never compile');

    // ---- autoreply: once per (channel, author), over the real child --
    await waitFor(() => publishes().length >= 2, 'autoreply publishes');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(publishes().sort(), [OTHER, 'discord:dm:999'].sort(),
      'one reply per channel+author despite two addressed messages from A');

    // ---- the focus channel still wakes --------------------------------
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'on it' }]));
    await i.handleMcplChannelIncoming(incoming(FOCUS, 'live one'));
    assert.deepEqual(i.pendingRequests.map((r) => r.agentName), ['scout']);
    await waitFor(() => membrane.calls.length >= 1, 'scout turn on the focus channel');
    await waitFor(() => i.agents.get('scout')!.state.status === 'idle', 'scout idle');
    i.pendingRequests.length = 0;
    // ---- check ---------------------------------------------------------
    const check = coordinator.handleTool({ mode: 'check' });
    const data = check.data as { focused: boolean; held: Array<{ channelId: string; messages: number; addressed: number }> };
    assert.equal(data.focused, true);
    assert.deepEqual(data.held.map((h) => [h.channelId, h.messages, h.addressed]).sort(),
      [[OTHER, 3, 2], ['discord:dm:999', 1, 1]].sort());
    // ---- end -----------------------------------------------------------
    // The end-of-focus wake runs a real scout turn; MockMembrane needs a
    // response queued or the harness restart-loops the turn.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'back' }]));
    const ended = coordinator.handleTool({ mode: 'end' });
    // Diagnostic guard: if an assertion below fails, `after()` stops the
    // framework mid-turn and the harness microtask-spins, starving the TAP
    // reporter — so the failure would be invisible. Log it synchronously.
    try {
    assert.deepEqual(ended, { success: true, data: { ended: true, held: 4 } });
    assert.deepEqual(i.pendingRequests.map((r) => [r.agentName, r.reason]), [['scout', 'focus ended (ended by you)']]);
    // The dump goes through addMessage, which defers under the turn-alive
    // guard and flushes at the next turn boundary — the wake queued above.
    let dump: Stored | undefined;
    await waitFor(() => Boolean(dump = cm.getAllMessages().find((m) => m.metadata?.kind === 'focus-end')), 'dump delivered');
    const text = textOf(dump!);
    assert.match(text, /4 messages held across 2 channels; 3 addressed you/);
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
