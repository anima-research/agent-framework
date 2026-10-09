/**
 * Tune-out with the reader as a succession of forks (Dendrite,
 * `subconscious.reader: 'forks'`): one subconscious cycle, end to end.
 *
 *   enter → ambient traffic is stamped, stored, wakes nobody → an addressed
 *   message derives a reader fork of the resident at its head: same tool
 *   block and system prompt, the resident's turns as its own prefix, the
 *   resident's refusals, the held traffic as framing → the fork reports
 *   through deliver_summary and the report lands in the resident's context
 *   as attributed mail under the fork's name and incarnation → the fork
 *   ends; the epoch does not → exceeding max-wakes auto-cancels: the
 *   resident gets the dump, and one last fork is handed only what no fork
 *   has seen yet.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest } from '@animalabs/membrane';
import { AgentFramework, AutobiographicalStrategy } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import type { NormalizedResponse } from '@animalabs/membrane';
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

/**
 * A fork presents as the resident, so a per-participant mock cannot tell
 * them apart — and `MockMembrane` hands its whole queue to whichever
 * stream starts first. This one keeps two queues and routes by the one
 * thing that distinguishes a reader's request: its framing message.
 */
class RoutedMembrane {
  calls: NormalizedRequest[] = [];
  lastStream: MockYieldingStream | null = null;
  private queues = { resident: [] as NormalizedResponse[], reader: [] as NormalizedResponse[] };

  push(who: 'resident' | 'reader', ...responses: NormalizedResponse[]): void {
    this.queues[who].push(...responses);
  }

  streamYielding(request: NormalizedRequest): MockYieldingStream {
    this.calls.push(request);
    const who = JSON.stringify(request.messages).includes('[Tune-out reader') ? 'reader' : 'resident';
    const stream = new MockYieldingStream(this.queues[who].splice(0));
    this.lastStream = stream;
    return stream;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

type Msg = { participant: string; content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> };
const textOf = (m: Msg | { content: Array<{ type: string; text?: string }> }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
const stripCache = (value: unknown): string =>
  JSON.stringify(value, (key, inner) => (key === 'cacheBreakpoint' || key === 'cache_control' ? undefined : inner));

describe('tune-out with reader forks', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let framework: AgentFramework;
  let commandPath: string;
  const traces: TraceEvent[] = [];

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tune-out-forks-'));
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new RoutedMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: {
        enabled: true,
        reader: 'forks',
        model: 'test-model',
        voice: 'You are reading for scout. Report in second person, briefly.',
      },
      mcplServers: [{
        id: 'disc',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    framework.onTrace((event) => traces.push(event));
    await framework.start();
    await waitFor(() => (internals(framework).channelRegistry?.listChannelsRaw().length ?? 0) > 0, 'channel registration');
  });

  after(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const emit = (kind: 'ambient' | 'addressed', id: string, text: string): void => {
    appendFileSync(commandPath, `${kind} ${id} ${text}\n`);
  };
  const scoutMessages = () => framework.getAgent('scout')!.getContextManager().getAllMessages() as unknown as Msg[];
  const forkTraces = () => traces.filter((t) => t.type === 'tune-out:reader-fork') as Array<
    TraceEvent & { agentName: string; trigger: string; held: number }
  >;

  it('runs one subconscious cycle as forks: divert → fork → report as mail → auto-cancel', async () => {
    const i = internals(framework);
    const coordinator = i.tuneOutCoordinator!;
    assert.ok(coordinator, 'coordinator exists with reader forks + mcpl, and no persistent subconscious');
    assert.equal(framework.getAgent('Subconscious'), null, 'no persistent reader agent');
    assert.deepEqual(framework.listAgents().map((r) => r.name), ['scout']);

    // ---- the resident's own request, for the prefix comparison ----------
    membrane.push('resident', createMockResponse([{ type: 'text', text: 'hi' }]));
    emit('addressed', 'm0', 'scout, are you around?');
    await waitFor(() => membrane.calls.length >= 1, 'scout wakes for an addressed message');
    const scoutRequest: NormalizedRequest = membrane.calls[0]!;
    assert.ok(
      scoutRequest.tools!.some((t) => t.name === 'deliver_summary'),
      'the reader\'s tools are in the resident\'s block so a fork can share the prefix',
    );
    await framework.runUntilIdle();

    // ---- enter + ambient traffic -----------------------------------------
    const entered = coordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 2, maxWakes: 1 }, 'agent-tool');
    assert.ok(entered.ok);
    emit('ambient', 'a1', 'release chatter one');
    emit('ambient', 'a2', 'release chatter two');
    emit('ambient', 'a3', 'release chatter three');
    await waitFor(() => scoutMessages().filter((m) => (m.metadata as { tuneOut?: unknown })?.tuneOut).length >= 3, 'three stamped messages');
    assert.equal(membrane.calls.length, 1, 'ambient diverted traffic wakes nobody, and derives no fork');
    assert.equal(forkTraces().length, 0);

    // ---- addressed message: one reader fork ------------------------------
    membrane.push(
      'reader',
      createMockResponse([
        { type: 'tool_use', id: 'call-report', name: 'deliver_summary', input: { text: 'Three release-chatter lines and one question for you; nothing urgent.', channelId: CHANNEL } },
      ], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'reported' }]),
    );
    membrane.push('resident', createMockResponse([{ type: 'text', text: 'thanks, reader' }]));
    emit('addressed', 'm1', 'hey scout, quick question');
    await waitFor(() => forkTraces().length >= 1, 'a reader fork is derived (coalesced wake)', 20_000);
    const first = forkTraces()[0]!;
    assert.equal(first.trigger, 'wake');
    assert.equal(first.held, 4, 'a1–a3 and m1: everything held so far, handed to this fork');
    assert.match(first.agentName, /^reader\/scout\//);

    await waitFor(() => framework.getAgentRecord(first.agentName)?.ended?.reason === 'completed', 'the fork ends when its turn ends', 20_000);
    const record = framework.getAgentRecord(first.agentName)!;
    assert.equal(record.kind, 'subconscious-fork');
    assert.equal(record.relationships.spawnedBy, 'scout');
    assert.equal(record.onParentEnd, 'end', 'attention tenancy: it would end with scout');
    assert.deepEqual(record.relationships.resultTo, { to: 'scout', as: 'message' });
    assert.equal(record.inherit?.mode, 'shared');
    assert.equal(record.inherit?.refusals, true, 'with scout\'s refusals');
    assert.equal(record.presentAs, 'scout');

    // The fork's framing: the notice, the voice block, and the held traffic — media-capable, author-attributed.
    const forkContext = await framework.inspectAgentContext(first.agentName);
    const framing = (forkContext.getAllMessages() as unknown as Msg[]).find((m) => m.metadata?.kind === 'tune-out-reader-framing')!;
    assert.ok(framing, 'framing is an ordinary stored message');
    const framingText = textOf(framing);
    assert.match(framingText, /\[Tune-out wake: disc:guild:noisy — 1 addressed message\]/);
    assert.match(framingText, /You are reading for scout/);
    assert.match(framingText, /antra: release chatter one/);
    assert.match(framingText, /hey scout, quick question/);
    assert.deepEqual((framing.metadata as { heldMessageIds: string[] }).heldMessageIds.length, 4);
    // The held originals stay out of the resident's compiled view.
    const compiled = await framework.getAgent('scout')!.getContextManager().compile();
    assert.ok(!compiled.messages.some((m) => textOf(m).includes('release chatter')));

    // The fork's request shares the resident's prefix: tools, system, and scout's turns as its own.
    const forkRequest = membrane.calls.find((c) => JSON.stringify(c.messages).includes('[Tune-out reader'))!;
    assert.ok(forkRequest, 'the fork made a request');
    assert.equal(JSON.stringify(forkRequest.tools), JSON.stringify(scoutRequest.tools), 'identical tool block');
    assert.equal(forkRequest.system, scoutRequest.system, 'identical system prompt: the voice block is framing');
    assert.equal(forkRequest.assistantParticipant, 'scout');
    const prefix = scoutRequest.messages.length;
    assert.equal(
      stripCache(forkRequest.messages.slice(0, prefix - 1)),
      stripCache(scoutRequest.messages.slice(0, prefix - 1)),
      'scout\'s request is a prefix of the fork\'s',
    );

    // The report is attributed mail: the fork's words under the fork's name and incarnation.
    await waitFor(() => scoutMessages().some((m) => m.metadata?.kind === 'agent-result'), 'the report reaches scout');
    const report = scoutMessages().find((m) => m.metadata?.kind === 'agent-result')!;
    assert.equal(report.participant, first.agentName);
    assert.match(textOf(report), /nothing urgent/);
    assert.deepEqual((report.metadata!.dendrite as { from: unknown }).from, { agent: first.agentName, incarnation: 1 });
    assert.equal(scoutMessages().some((m) => textOf(m).includes('[Tune-out wake:')), false, 'notices never leak into the resident\'s window');

    // The agent ended; the epoch did not.
    assert.equal(framework.listPolicyEpochs().length, 1);
    assert.equal(framework.listAgents().some((r) => r.kind === 'subconscious-fork'), false, 'no reader persists between invocations');
    await framework.runUntilIdle(); // scout's wake for the mail

    // ---- a second wake exceeds maxWakes=1: auto-cancel -------------------
    membrane.push('resident', createMockResponse([{ type: 'text', text: 'ack' }]));
    membrane.push('reader', createMockResponse([{ type: 'text', text: 'final look' }]));
    emit('addressed', 'm2', 'scout are you there?');
    await waitFor(() => i.channelRegistry!.getDesiredState('disc', CHANNEL) === 'open', 'auto-cancel returns the channel to open', 20_000);
    await waitFor(() => scoutMessages().some((m) => textOf(m).includes('<tuned-out-backlog')), 'the dump reaches scout');
    await waitFor(() => forkTraces().some((t) => t.trigger === 'cancel'), 'one last fork for the cancel', 20_000);
    const last = forkTraces().find((t) => t.trigger === 'cancel')!;
    assert.equal(last.held, 1, 'only m2: the rest was handed to the first fork');
    await waitFor(() => framework.getAgentRecord(last.agentName)?.ended?.reason === 'completed', 'the cancel fork ends', 20_000);
    const lastFraming = (await framework.inspectAgentContext(last.agentName)).getAllMessages() as unknown as Msg[];
    assert.match(textOf(lastFraming.find((m) => m.metadata?.kind === 'tune-out-reader-framing')!), /\[Tune-out cancelled: disc:guild:noisy — wake budget exhausted/);
    assert.equal(framework.listPolicyEpochs().length, 0);
    assert.deepEqual(
      framework.listAgents({ includeEnded: true }).filter((r) => r.kind === 'subconscious-fork').map((r) => r.ended?.reason),
      ['completed', 'completed'],
    );
    await framework.runUntilIdle();

    // ---- the resident cannot use the reader's tools ----------------------
    membrane.push(
      'resident',
      createMockResponse([
        { type: 'tool_use', id: 'call-nope', name: 'deliver_summary', input: { text: 'me?', channelId: CHANNEL } },
      ], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'ok' }]),
    );
    emit('addressed', 'm3', 'scout one more');
    await waitFor(() => (membrane.lastStream?.receivedToolResults.length ?? 0) >= 1, 'scout\'s call is answered', 20_000);
    assert.match(JSON.stringify(membrane.lastStream!.receivedToolResults[0]), /available to the resident's reader, not to scout/);
    await framework.runUntilIdle();
  });
});

describe('tune-out reader forks: configuration', () => {
  it('refuses an unstated model: whose weights read the prefix is never defaulted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tune-out-forks-cfg-'));
    try {
      await assert.rejects(
        AgentFramework.create({
          storePath: join(dir, 'test.chronicle'),
          membrane: new MockMembrane().asMembrane(),
          agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'x' }],
          subconscious: { enabled: true, reader: 'forks', voice: 'read' } as never,
          modules: [],
        }),
        /`model` must say whose weights run it — "test-model" for a copy of the resident, or another model/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows another model when stated: every configuration stays reachable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tune-out-forks-cfg-'));
    try {
      const framework = await AgentFramework.create({
        storePath: join(dir, 'test.chronicle'),
        membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'x' }],
        subconscious: { enabled: true, reader: 'forks', model: 'other-model', voice: 'read' },
        modules: [],
      });
      await framework.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses forks for a folding resident without a strategy factory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tune-out-forks-cfg-'));
    try {
      await assert.rejects(
        AgentFramework.create({
          storePath: join(dir, 'test.chronicle'),
          membrane: new MockMembrane().asMembrane(),
          agents: [{
            name: 'scout', model: 'test-model', systemPrompt: 'x',
            strategy: new AutobiographicalStrategy({ compressionModel: 'mock' }) as never,
          }],
          subconscious: { enabled: true, reader: 'forks', model: 'test-model', voice: 'read' },
          modules: [],
        }),
        /needs `subconscious.strategyFactory`/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
