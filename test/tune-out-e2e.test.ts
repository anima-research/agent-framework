/**
 * Tune-out end-to-end (issue #77): a real MCPL channel diverts to the
 * subconscious and comes back.
 *
 *   enter → ambient traffic is stamped + stored + never wakes the resident,
 *   and never enters their compiled view (but does enter the subconscious's
 *   merged view) → an addressed message gets the deterministic
 *   suppressed-mention acknowledge AND a coalesced subconscious wake turn →
 *   exceeding max-wakes auto-cancels: the resident receives the
 *   system-framed <tuned-out-backlog> dump (capped) and one wake, with the
 *   raw stamped originals still excluded from their view.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

function internals(framework: AgentFramework) {
  return framework as unknown as {
    tuneOutCoordinator: TuneOutCoordinator | null;
    channelRegistry: {
      listChannelsRaw(): Array<{ serverId: string; descriptor: { id: string } }>;
      getDesiredState(serverId: string, channelId: string): string | undefined;
      getTuneOutState(serverId: string, channelId: string): { wakeCount: number } | null;
    } | null;
    agents: Map<string, { getContextManager(): {
      getAllMessages(): Array<{ participant: string; content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> }>;
      compile(): Promise<{ messages: Array<{ participant: string; content: Array<{ type: string; text?: string }> }> }>;
    } }>;
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const textOf = (m: { content: Array<{ type: string; text?: string }> }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

describe('tune-out end to end', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let statusPath: string;
  let commandPath: string;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tune-out-e2e-'));
    statusPath = join(tempDir, 'status.jsonl');
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: {
        enabled: true,
        systemPrompt:
          'You are the Subconscious. You watch tuned-out channels for the resident ' +
          'and report to them in second person, briefly.',
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
  });

  after(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function emit(kind: 'ambient' | 'addressed', id: string, text: string): void {
    appendFileSync(commandPath, `${kind} ${id} ${text}\n`);
  }

  function statusEvents(): Array<{ event: string; intent?: string; messageId?: string }> {
    if (!existsSync(statusPath)) return [];
    return readFileSync(statusPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('runs the full divert → wake → auto-cancel arc', async () => {
    const i = internals(framework);
    const coordinator = i.tuneOutCoordinator!;
    assert.ok(coordinator, 'coordinator exists when subconscious + mcpl are configured');

    // ---- enter -----------------------------------------------------------
    const entered = coordinator.enter('disc', CHANNEL, {
      cadenceSeconds: 3600, // cadence not exercised here; wake path is
      backlogCap: 2,
      maxWakes: 1,
    }, 'agent-tool');
    assert.ok(entered.ok, 'enter succeeds');
    assert.equal(i.channelRegistry!.getDesiredState('disc', CHANNEL), 'tuned-out');

    // ---- ambient traffic: stamped, stored, no resident wake --------------
    emit('ambient', 'a1', 'release chatter one');
    emit('ambient', 'a2', 'release chatter two');
    emit('ambient', 'a3', 'release chatter three');

    const scout = i.agents.get('scout')!.getContextManager();
    await waitFor(
      () => scout.getAllMessages().filter((m) => (m.metadata as { tuneOut?: unknown })?.tuneOut).length >= 3,
      'three stamped diverted messages',
    );
    assert.equal(membrane.calls.length, 0, 'nobody woke for ambient diverted traffic');

    const compiled = await scout.compile();
    assert.ok(
      !compiled.messages.some((m) => textOf(m).includes('release chatter')),
      'diverted messages never enter the resident\'s compiled view',
    );
    const sub = i.agents.get('Subconscious')!.getContextManager();
    const subCompiled = await sub.compile();
    assert.ok(
      subCompiled.messages.some((m) => textOf(m).includes('release chatter one')),
      'the subconscious\'s merged view includes the diverted backlog',
    );

    // ---- addressed message: ack + coalesced subconscious wake ------------
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Noted — nothing urgent yet.' }]));
    emit('addressed', 'm1', 'hey scout, quick question');

    await waitFor(
      () => statusEvents().some((e) => e.event === 'acknowledge' && e.intent === 'suppressed-tuned-out' && e.messageId === 'm1'),
      'deterministic suppressed-mention acknowledge',
    );
    await waitFor(() => membrane.calls.length >= 1, 'subconscious wake turn (coalesced)', 20_000);
    await waitFor(
      () => (i.channelRegistry!.getTuneOutState('disc', CHANNEL)?.wakeCount ?? -1) === 1,
      'durable wake count = 1',
    );
    assert.ok(
      sub.getAllMessages().some((m) => textOf(m).includes('[Tune-out wake:')),
      'the wake notice landed in the subconscious\'s own window',
    );
    assert.ok(
      !scout.getAllMessages().some((m) => textOf(m).includes('[Tune-out wake:')),
      'wake notices do not leak into the resident\'s window',
    );

    // ---- second wake exceeds maxWakes=1: auto-cancel ---------------------
    // Two turns follow the cancel: the resident's wake and the
    // subconscious's cancel-report (issue: dump + a message from the
    // subconscious). MockMembrane hands all queued responses to whichever
    // stream starts first, so queue two and assert on durable state only.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack one' }]));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack two' }]));
    emit('addressed', 'm2', 'scout are you there?');

    await waitFor(
      () => i.channelRegistry!.getDesiredState('disc', CHANNEL) === 'open',
      'auto-cancel returns the channel to open',
      20_000,
    );

    await waitFor(
      () => scout.getAllMessages().some((m) => textOf(m).includes('<tuned-out-backlog')),
      'the backlog dump reaches the resident',
    );
    await waitFor(
      () => sub.getAllMessages().some((m) => textOf(m).includes('[Tune-out cancelled:')),
      'the subconscious received its cancel-report notice',
    );
    const dumpMsg = scout.getAllMessages().find((m) => textOf(m).includes('<tuned-out-backlog'))!;
    const dump = textOf(dumpMsg);
    assert.match(dump, /\[Tune-out: disc:guild:noisy cancelled — wake budget exhausted \(1\), 2 wakes\]/);
    assert.match(dump, /truncated=/, 'backlogCap=2 with 5 diverted messages truncates');
    assert.match(dump, /antra: /, 'dump lines carry author attribution');

    // The stamped originals stay excluded even after cancel; the dump is
    // the delivery (KV-prefix-stable append, not retro-insertion).
    const recompiled = await scout.compile();
    const renderedTexts = recompiled.messages.map(textOf);
    assert.ok(
      renderedTexts.some((t) => t.includes('<tuned-out-backlog')),
      'the dump is visible',
    );
    assert.ok(
      !renderedTexts.some((t) => t.includes('release chatter one') && !t.includes('<tuned-out-backlog')),
      'raw stamped originals stay view-excluded permanently',
    );
  });
});
