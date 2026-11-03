/**
 * A persisted reader (`subconscious.persist`), further cases. The base cases
 * are in tune-out-reader-persist.test.ts, whose boot() this file copies.
 *
 * - a look a stop cut off, resumed after the restart;
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageId, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { FrameworkConfig, TraceEvent } from '../src/index.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { WireMembrane, final } from './helpers/wire-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (m: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

async function waitFor(what: string, cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

type Invocation = {
  serverId: string; channelId: string; epochId: string; trigger: 'cadence' | 'wake' | 'cancel';
  notice: string; backlog: StoredMessage[]; dispositions: string | null; epochEnded?: true;
};
type Internals = {
  tuneOutCoordinator: TuneOutCoordinator;
  channelRegistry: { listChannelsRaw(): unknown[] };
  invokeReaderFork(invocation: Invocation): void;
  addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): MessageId;
  pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
  store: { listBranches(): Array<{ name: string }> };
};
type ForkTrace = TraceEvent & {
  agentName: string; epochId: string; held: number; incarnation?: number; resumed?: boolean; resynced?: number; trigger: string;
};
type FailedTrace = TraceEvent & { agentName: string; error: string; reported: boolean; returned: number };

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const newDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A framework with reader forks and the tune-out fixture server, on `dir`'s store; a second boot on one `dir` is a restart. */
async function boot(dir: string, subconscious: Record<string, unknown>, extra: Partial<FrameworkConfig> = {}) {
  const commandPath = join(dir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new WireMembrane();
  membrane.identify = (request) => (JSON.stringify(request.messages).includes('[Tune-out reader') ? 'reader' : 'scout');
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
    subconscious: { enabled: true, reader: 'forks', model: 'test-model', voice: 'Read for scout.', ...subconscious },
    mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(dir, 'status.jsonl'), COMMAND_PATH: commandPath } }],
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    ...extra,
  } as never);
  frameworks.push(framework);
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e), { replay: true });
  const internals = framework as unknown as Internals;
  await framework.start();
  await waitFor('channel registration', () => internals.channelRegistry.listChannelsRaw().length > 0);
  const scout = () => framework.getAgent('scout')!;
  const rows = () => scout().getContextManager().getAllMessages();
  /** A row held by the tune-out `epochId`, stored as admission stores one. */
  const hold = (epochId: string, t: string): StoredMessage => {
    const id = internals.addMessage('antra', [text(t)], { tuneOut: { epochId }, channelId: CHANNEL, serverId: 'disc', author: { id: 'u1', name: 'antra' } });
    return rows().find((m) => m.id === id)!;
  };
  /** Every row the tune-out `epochId` held: what its first look after a restart is handed, the coordinator's cursor being gone. */
  const heldBy = (epochId: string): StoredMessage[] =>
    rows().filter((m) => (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId);
  /** A look the coordinator would ask for, handed `backlog`. */
  const look = (epochId: string, backlog: StoredMessage[], trigger: Invocation['trigger'] = 'cadence') =>
    internals.invokeReaderFork({ serverId: 'disc', channelId: CHANNEL, epochId, trigger, notice: `[Tune-out ${trigger}: test]`, backlog, dispositions: null });
  /** A turn of scout's on a message from antra, scripted with `reply`. */
  const residentTurn = async (said: string, reply: string) => {
    membrane.script('scout', final([text(reply)]));
    internals.addMessage('antra', [text(said)], { author: { id: 'u1', name: 'antra' } }, { forAgent: 'scout' });
    internals.pendingRequests.push({ agentName: 'scout', reason: 'test', source: 'test', timestamp: Date.now() });
    await waitFor(`scout's reply ${reply}`, () => rows().some((m) => textOf(m) === reply));
    await framework.runUntilIdle();
  };
  const enter = () => {
    const entered = internals.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 50 }, 'agent-tool');
    assert.ok(entered.ok);
    return entered.params.epochId as string;
  };
  const forkTraces = () => traces.filter((t) => t.type === 'tune-out:reader-fork') as ForkTrace[];
  const failedTraces = () => traces.filter((t) => t.type === 'tune-out:reader-fork-failed') as FailedTrace[];
  const rederived = () => traces.filter((e) => e.type === 'tune-out:reader-rederived')
    .map((e) => { const r = e as unknown as { agentName: string; previous: string; reason: string }; return [r.previous, r.agentName, r.reason]; });
  /** Wait for the look that makes `name`'s record reach `incarnation` to end. */
  const looked = async (name: string, incarnation: number) => {
    await waitFor(`${name} incarnation ${incarnation} ended`, () => {
      const record = framework.getAgentRecord(name);
      return !!record?.ended && record.incarnation === incarnation;
    });
    await framework.runUntilIdle();
  };
  /** This process's framework stops; the next boot on `dir` is its restart. */
  const stopped = async () => {
    await framework.stop();
    frameworks.splice(frameworks.indexOf(framework), 1);
  };
  return {
    framework, membrane, traces, internals, scout, rows, hold, heldBy, look, residentTurn, enter,
    forkTraces, failedTraces, rederived, looked, stopped,
  };
}

const framingsOf = async (framework: AgentFramework, name: string) =>
  (await framework.inspectAgentContext(name)).getAllMessages()
    .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'tune-out-reader-framing');

describe('a persisted reader: across a restart', () => {
  it('ends a look a stop cut off as host-restart, and resumes it at the next look without handing its held row again', { timeout: 180_000 }, async () => {
    const dir = newDir('reader-persist-more-cut-');
    const first = await boot(dir, { persist: 'epoch' });
    const epochId = first.enter();
    const name = `reader/scout/${epochId.slice(0, 8)}/g1`;
    // The first look is derived and runs; its stream is held, so the stop
    // finds it in flight.
    let release!: () => void;
    first.membrane.hold('reader', new Promise<void>((r) => { release = r; }));
    first.look(epochId, [first.hold(epochId, 'HELD-1 before the stop')]);
    await waitFor('the first look is running', () => first.membrane.callsFor('reader').length === 1);
    assert.equal(first.framework.getAgentRecord(name)?.ended, undefined, 'premise: the look is live when the stop comes');
    const stopping = first.stopped();
    release();
    await stopping;

    const second = await boot(dir, { persist: 'epoch' });
    const cut = second.framework.getAgentRecord(name);
    assert.deepEqual([cut?.incarnation, cut?.ended?.reason], [1, 'host-restart'], 'the cut-off look ends as host-restart');
    assert.deepEqual((await framingsOf(second.framework, name)).map((m) => (m.metadata as { heldMessageIds: string[] }).heldMessageIds.length), [1],
      "premise: its framing is on its branch, stored before its run");
    // After a restart the coordinator's cursor is gone, so the epoch's first
    // look is handed all it held, the cut-off look's row included.
    second.hold(epochId, 'HELD-2 after the restart');
    const backlog = second.heldBy(epochId);
    assert.equal(backlog.length, 2, 'premise: the whole epoch is handed');
    second.membrane.script('reader', final([text('After the restart.')]));
    second.look(epochId, backlog);
    await waitFor('the look after the restart', () => second.forkTraces().length + second.failedTraces().length > 0);
    assert.deepEqual(second.forkTraces().map((f) => [f.agentName, f.incarnation, f.resumed, f.held]), [[name, 2, true, 1]],
      'resumed at incarnation 2, handed the new row alone');
    assert.deepEqual(second.rederived(), [], 'not derived again');
    await second.looked(name, 2);
    const request = second.membrane.callsFor('reader')[0]!;
    const body = JSON.stringify(request.messages);
    assert.equal(occurrences(body, 'HELD-1 before the stop'), 1, "the cut-off look's row is in the request once: its own framing's");
    const last = JSON.stringify(request.messages.at(-1));
    assert.ok(last.includes('HELD-2 after the restart') && !last.includes('HELD-1'), last);
  });
});
