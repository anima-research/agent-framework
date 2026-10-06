/**
 * Focus mode and outbound routing, end to end over a real MCPL child.
 *
 * The 2026-09-30 misroute: a batched (channel-less) wake for a DM fell back to
 * the process-global default locus, which an ambient message in another
 * channel had retargeted one second earlier — the DM reply was published
 * into that channel. Focus must close this: while focused, held inbound does
 * not move the default, the focus channel is the locus for every turn, and
 * entering focus mid-turn moves the current turn's prose there.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { FocusCoordinator } from '../src/focus/coordinator.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const FOCUS = 'disc:guild:noisy';   // registered by the fixture
const OTHER = 'disc:guild:other';   // registered here, same server

type Stored = { participant: string; content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> };

function internals(framework: AgentFramework) {
  return framework as unknown as {
    focusCoordinator: FocusCoordinator | null;
    channelRegistry: ChannelRegistry | null;
    pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
    agents: Map<string, { state: { status: string }; getContextManager(): { getAllMessages(): Stored[] } }>;
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

describe('focus routing through the framework', () => {
  let tempDir: string;
  let statusPath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let n = 0;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'focus-route-'));
    statusPath = join(tempDir, 'status.jsonl');
    const commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      focus: { enabled: true },
      gate: { config: { policies: [], default: 'always' } },
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

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** channels/incoming through the REAL registry path (it owns the default locus). */
  function inbound(channelId: string, text: string): void {
    internals(framework).channelRegistry!.handleIncoming('disc', {
      messages: [{
        channelId,
        messageId: `m-${++n}`,
        author: { id: 'U1', name: 'antra' },
        timestamp: new Date().toISOString(),
        content: [{ type: 'text', text }],
        tags: ['chat:ambient', 'chat:from-human'],
      }],
    });
  }

  function publishes(): string[] {
    if (!existsSync(statusPath)) return [];
    return readFileSync(statusPath, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; channelId?: string })
      .filter((e) => e.event === 'publish')
      .map((e) => e.channelId!);
  }

  async function idle(): Promise<void> {
    await waitFor(() => internals(framework).agents.get('scout')!.state.status === 'idle', 'scout idle');
  }

  it('held inbound cannot steer a channel-less wake; the focus channel is the locus, during and after', async () => {
    const i = internals(framework);

    // Establish the focus channel as the last inbound (a normal wake + reply).
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello focus' }] as ContentBlock[]));
    inbound(FOCUS, 'hi');
    await waitFor(() => publishes().length >= 1, 'first reply');
    await idle();
    assert.deepEqual(publishes(), [FOCUS]);

    assert.equal(i.focusCoordinator!.handleTool({ mode: 'enter', channelId: FOCUS, durationSeconds: 600 }).success, true);

    // An ambient message elsewhere arrives (held — stored, no wake).
    inbound(OTHER, 'chatter in another room');
    await waitFor(
      () => i.agents.get('scout')!.getContextManager().getAllMessages()
        .some((m) => (m.metadata as { focusHeld?: unknown } | undefined)?.focusHeld),
      'held message stored',
    );
    assert.equal(i.channelRegistry!.getDefaultPublishChannel(), FOCUS, 'held inbound did not retarget the default');

    // A batched gate wake carries no channel (the incident's wake shape).
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'reply to the focus room' }] as ContentBlock[]));
    i.pendingRequests.push({ agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: Date.now() });
    await waitFor(() => publishes().length >= 2, 'channel-less wake reply');
    await idle();
    assert.deepEqual(publishes(), [FOCUS, FOCUS], 'the channel-less wake replied into the focus channel');

    // Ending focus wakes the resident with no channel; the held message never
    // became the fallback, so the reply still lands where they were.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'back' }] as ContentBlock[]));
    assert.equal(i.focusCoordinator!.handleTool({ mode: 'end' }).success, true);
    await waitFor(() => publishes().length >= 3, 'post-focus reply');
    await idle();
    assert.deepEqual(publishes(), [FOCUS, FOCUS, FOCUS]);
    assert.equal(i.channelRegistry!.getFocusLocus(), null, 'focus locus cleared at end');
  });

  it('entering focus mid-turn moves that turn\'s prose to the focus channel and says so in the tool result', async () => {
    // Turn triggered from OTHER (not focused yet); the resident enters focus
    // on FOCUS and keeps talking — that prose belongs in FOCUS.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'f1', name: 'focus', input: { mode: 'enter', channelId: FOCUS, durationSeconds: 600 } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'now only here' }] as ContentBlock[]));
    inbound(OTHER, 'come focus with me');
    await waitFor(() => publishes().length >= 1, 'post-enter prose');
    await idle();

    assert.deepEqual(publishes(), [FOCUS], 'prose after enter landed in the focus channel, not the trigger channel');
    const results = membrane.lastStream!.receivedToolResults.flat();
    assert.ok(
      JSON.stringify(results).includes('plain speech lands in the focus channel'),
      'routing note rides the focus tool result',
    );
  });
});
