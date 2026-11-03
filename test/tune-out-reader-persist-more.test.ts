/**
 * A persisted reader (`subconscious.persist`), further cases. The base cases
 * are in tune-out-reader-persist.test.ts, whose boot() this file copies.
 *
 * - a look a stop cut off, resumed after the restart;
 * - the resident's rows between two looks, on either side of a restart;
 * - one `'resident'` identity across two tune-outs;
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageId, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, defaultReaderFraming } from '../src/index.js';
import type { FrameworkConfig, ReaderFramingContext, TraceEvent } from '../src/index.js';
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

  it("hands the look after a restart the resident's rows since the look before it, from either side of the restart", { timeout: 180_000 }, async () => {
    const dir = newDir('reader-persist-more-resync-');
    const first = await boot(dir, { persist: 'epoch' });
    await first.residentTurn('EARLY-1 hello scout', 'EARLY-2 scout hears you');
    const epochId = first.enter();
    const name = `reader/scout/${epochId.slice(0, 8)}/g1`;
    first.membrane.script('reader', final([text('READER-REPORT-1 one held message.')]));
    first.membrane.script('scout', final([text('MID-0 noted the report')]));
    first.look(epochId, [first.hold(epochId, 'HELD-1')]);
    await first.looked(name, 1);
    await waitFor("scout's turn on the report", () => first.rows().some((m) => textOf(m) === 'MID-0 noted the report'));
    await first.residentTurn('MID-1 before the restart', 'MID-2 scout, before the restart');
    await first.stopped();

    const contexts: ReaderFramingContext[] = [];
    const second = await boot(dir, { persist: 'epoch', framing: (ctx: ReaderFramingContext) => { contexts.push(ctx); return defaultReaderFraming(ctx); } });
    await second.framework.runUntilIdle();
    await second.residentTurn('MID-3 after the restart', 'MID-4 scout, after the restart');
    second.membrane.script('reader', final([text('READER-REPORT-2')]));
    second.look(epochId, [second.hold(epochId, 'HELD-2')]);
    await second.looked(name, 2);

    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]!.resumed, true, 'premise: resumed, not derived');
    const handed = contexts[0]!.residentRows ?? [];
    const texts = handed.map((m) => textOf(m));
    assert.deepEqual(texts.filter((h) => h.startsWith('MID-')), [
      'MID-0 noted the report', 'MID-1 before the restart', 'MID-2 scout, before the restart',
      'MID-3 after the restart', 'MID-4 scout, after the restart',
    ], "the resident's rows since the first look, in window order: those before the restart and those after it");
    assert.ok(!texts.some((h) => h.includes('EARLY') || h.includes('HELD-')), 'none from before the first look, and no held row');
    assert.equal(second.forkTraces()[0]!.resynced, handed.length, 'the trace counts what it was handed');
    const sent = JSON.stringify(second.membrane.callsFor('reader')[0]!.messages.at(-1));
    assert.ok(sent.includes(`[In scout's context since your last look: ${handed.length} messages]`), sent);
  });
});

describe('a persisted reader: across tune-outs', () => {
  it("with 'resident', resumes the one identity at the next tune-out's look, with that tune-out's epoch on its record", { timeout: 180_000 }, async () => {
    const dir = newDir('reader-persist-more-epochs-');
    const t = await boot(dir, { persist: 'resident' });
    const name = 'reader/scout/g1';
    const firstEpoch = t.enter();
    t.membrane.script('reader', final([text('First tune-out, first look.')]));
    t.look(firstEpoch, [t.hold(firstEpoch, 'HELD-1 in the first tune-out')]);
    await t.looked(name, 1);
    t.hold(firstEpoch, 'HELD-2 before the cancel');
    assert.deepEqual(t.internals.tuneOutCoordinator.cancel('disc', CHANNEL, 'agent-tool', 'test cancel'), { ok: true });
    await t.looked(name, 2);

    const secondEpoch = t.enter();
    assert.notEqual(secondEpoch, firstEpoch, 'premise: a second tune-out');
    t.membrane.script('reader', final([text('Second tune-out, first look.')]));
    t.look(secondEpoch, [t.hold(secondEpoch, 'HELD-3 in the second tune-out')]);
    await waitFor("the second tune-out's look", () => t.forkTraces().length + t.failedTraces().length > 2);
    assert.deepEqual(t.forkTraces().map((f) => [f.agentName, f.incarnation, f.resumed, f.trigger, f.epochId]), [
      [name, 1, false, 'cadence', firstEpoch],
      [name, 2, true, 'cancel', firstEpoch],
      [name, 3, true, 'cadence', secondEpoch],
    ], 'derived once, then resumed: at the first tune-out\'s cancel and at the second tune-out\'s first look');
    assert.deepEqual(t.rederived(), [], 'never derived again');
    await t.looked(name, 3);
    assert.equal(t.framework.getAgentRecord(name)!.metadata!.epochId, secondEpoch, "its record carries the look's epoch, the second tune-out's");
    assert.deepEqual(t.internals.store.listBranches().map((b) => b.name).filter((b) => b.startsWith('dendrite/reader/')), [`dendrite/${name}`],
      'one branch: nothing was derived again');
    const body = JSON.stringify(t.membrane.callsFor('reader').at(-1)!.messages);
    assert.ok(body.includes('HELD-1 in the first tune-out') && body.includes('First tune-out, first look.'),
      'its request holds what it was handed and said in the first tune-out');
  });
});
