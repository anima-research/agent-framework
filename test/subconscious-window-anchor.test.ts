/**
 * Where the persistent subconscious's window starts (#291, AF-5): at the
 * oldest active tune-out's start, as a sequence while its window is the
 * record, and, with the presentation index, as an index ordinal fixed once
 * per tune-out and kept (`subconscious/<primary>/window-starts`), so it is
 * never converted from the tune-out's sequence again.
 *
 * (a) A tune-out entered while the subconscious's turn is alive: rows the
 *     residents' slot took before the tune-out began, which its window took
 *     only at its turn's end, stay out of the window its tune-out requests
 *     read. (b) Another tune-out's enter, after the window was re-anchored
 *     and a row from before the start was presented again past the held
 *     rows, sets the start back to the older tune-out's ordinal exactly. (c)
 *     The start is the same after a restart, over the same window. (d)
 *     While the window is the record (an earlier release's, or one whose
 *     write-down failed, which pins it so for the process) the start is set
 *     by sequence, as before. (e) A kept ordinal past a shorter window is
 *     clamped and traced. (f) A tune-out active at the upgrade gets its
 *     ordinal right after the window is written down, in record order. (g)
 *     A cancel forgets the tune-out's start. (h) A cancel of the oldest
 *     tune-out while another stays active leaves the start where it was, so
 *     the report on it reads what it held, and a restart keeps that start
 *     (its `inForce`) rather than setting the other's.
 *
 * Since #291 every framework presents, so the tests stand in for an earlier
 * release's process by one whose write-down fails (boot's `legacy`), which keeps
 * each window the record for that process, as that release kept it.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContextManager } from '@animalabs/context-manager';
import type { MessageId, MessageMetadata, StoredMessage, WindowedPassthroughStrategy } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { SubconsciousWindowAnchor, type AnchoredStrategy } from '../src/tune-out/window-anchor.js';
import { WireMembrane, final, signed } from './helpers/wire-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';
const SUB = 'Subconscious';
const STARTS = 'subconscious/scout/window-starts';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (m: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

async function waitFor(what: string, cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

type Internals = {
  tuneOutCoordinator: TuneOutCoordinator;
  subconsciousStrategy: WindowedPassthroughStrategy | null;
  channelRegistry: { listChannelsRaw(): unknown[]; readCoordinatorState(id: string): unknown; writeCoordinatorState(id: string, value: unknown): void };
  pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string }): MessageId;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function place() {
  const dir = mkdtempSync(join(tmpdir(), 'sub-window-anchor-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'commands.txt'), '');
  return dir;
}

/**
 * scout and the persistent subconscious over the tune-out fixture's channel,
 * on `dir`'s store. `legacy`: each window's write-down fails at its
 * registration, so the process keeps every window the record, as a release
 * before #291 did (presentation.adopt pins it).
 */
async function boot(dir: string, legacy = false) {
  const presentRows = ContextManager.prototype.presentRows;
  if (legacy) {
    ContextManager.prototype.presentRows = function (this: ContextManager, ids: Parameters<typeof presentRows>[0], ...rest: unknown[]) {
      if (ids.length === 0) throw new Error('the write-down is refused (test: a process as an earlier release ran)');
      return (presentRows as (...a: unknown[]) => ReturnType<typeof presentRows>).call(this, ids, ...rest);
    } as typeof presentRows;
  }
  const membrane = new WireMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
    subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for scout.' },
    mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(dir, 'status.jsonl'), COMMAND_PATH: join(dir, 'commands.txt') } }],
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  } as never).finally(() => { ContextManager.prototype.presentRows = presentRows; });
  frameworks.push(framework);
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e));
  const internals = framework as unknown as Internals;
  await framework.start();
  await waitFor('channel registration', () => internals.channelRegistry.listChannelsRaw().length > 0);
  const subCm = () => framework.getAgent(SUB)!.getContextManager();
  const strategy = () => internals.subconsciousStrategy!;
  const residentRow = (t: string, metadata: Record<string, unknown> = {}) =>
    internals.addMessage('antra', [text(t)], { channelId: CHANNEL, serverId: 'disc', ...metadata } as MessageMetadata, { forAgent: 'scout' });
  const rowOf = (t: string): StoredMessage => framework.getAgent('scout')!.getContextManager().getAllMessages().find((m) => textOf(m) === t)!;
  const windowStarts = () => (internals.channelRegistry.readCoordinatorState(STARTS) as { v: number; starts: Record<string, number> } | null)?.starts;
  const ask = () => internals.pendingRequests.push({ agentName: SUB, reason: 'test', source: 'test', timestamp: Date.now() });
  const windowFixes = () => traces.filter((e) => e.type === 'tune-out:subconscious-window') as Array<Extract<TraceEvent, { type: 'tune-out:subconscious-window' }>>;
  // A tune-out starts at the store's head (startedAtSequence), and the row at
  // that sequence is in its window, as a sequence anchor has it. A record
  // that isn't a row, written before the enter, puts the rows before it
  // strictly before the start.
  let bumps = 0;
  const bump = () => internals.channelRegistry.writeCoordinatorState('test/bump', { n: ++bumps });
  return { framework, membrane, traces, internals, subCm, strategy, residentRow, rowOf, windowStarts, ask, windowFixes, bump };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/**
 * The subconscious's turn is alive (its request is being made) when two of
 * the resident's rows are stored and the tune-out T1 is entered; its reply,
 * its own row, enters its window at its write, and the two rows at its
 * turn's end. Then two held rows of T1's, with the subconscious at rest.
 */
async function enterDuringItsTurn(h: Booted) {
  let epochId: string | undefined;
  let fixedAtEnter: number | undefined;
  // Its reply sets its text aside (explicit prose routing), so nothing
  // answers it and no further turn of its follows.
  h.membrane.script(SUB, final([signed('sig-a'), text('>>skip_reply nothing yet')]));
  h.membrane.onRequest = (agent) => {
    if (agent !== SUB || epochId) return;
    h.residentRow('PRE-1 before the tune-out');
    h.residentRow('PRE-2 before the tune-out');
    h.bump();
    const entered = h.internals.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool');
    assert.ok(entered.ok, 'entered');
    epochId = entered.params.epochId;
    fixedAtEnter = h.windowFixes().length;
  };
  h.ask();
  await waitFor('the tune-out entered during its turn', () => epochId !== undefined);
  await h.framework.runUntilIdle();
  const reply = h.subCm().getAllMessages().find((m) => m.content.some((b) => b.type === 'thinking' && (b as { signature?: string }).signature === 'sig-a'))!;
  assert.ok(reply, 'its reply was stored');
  h.residentRow('T1-HELD-1 chatter', { tuneOut: { epochId } });
  h.residentRow('T1-HELD-2 chatter', { tuneOut: { epochId } });
  await h.framework.runUntilIdle();
  return { epochId: epochId!, fixedAtEnter: fixedAtEnter!, reply };
}

describe("the persistent subconscious's window start (#291, AF-5)", () => {
  it('(a) leaves out the rows stored before a tune-out began that its window took after, (b) comes back to its kept ordinal after a re-anchor, (g) and goes at the cancel', { timeout: 120_000 }, async () => {
    const h = await boot(place());
    const { epochId, fixedAtEnter, reply } = await enterDuringItsTurn(h);
    const cm = h.subCm();
    const ordinal = (t: string) => cm.ordinalOf(h.rowOf(t).id)!;
    assert.equal(fixedAtEnter, 0, 'not fixed at the enter: the rows stored before it were still out of the window');
    assert.ok(cm.ordinalOf(reply.id)! < ordinal('PRE-1 before the tune-out'), 'premise: its reply entered its window ahead of the rows stored before the tune-out');
    const start = ordinal('PRE-2 before the tune-out') + 1;
    assert.equal(ordinal('T1-HELD-1 chatter'), start, 'premise: the first held row is the next to enter');
    assert.deepEqual(h.windowFixes().map((e) => ({ how: e.how, ordinal: e.ordinal, epochIds: e.epochIds })), [{ how: 'fixed', ordinal: start, epochIds: [epochId] }],
      'fixed once at its turn end, past the last row stored before the tune-out');
    assert.equal(h.strategy().getAnchorOrdinal(), start);
    assert.deepEqual(h.windowStarts(), { [epochId]: start }, 'and kept');

    // (a) What its tune-out requests read.
    h.membrane.script(SUB, final([signed('sig-b'), text('>>skip_reply still nothing')]));
    h.ask();
    await waitFor('its next request', () => h.membrane.callsFor(SUB).length >= 2);
    await h.framework.runUntilIdle();
    const body = JSON.stringify(h.membrane.callsFor(SUB).at(-1)!.messages);
    assert.ok(body.includes('T1-HELD-1 chatter') && body.includes('T1-HELD-2 chatter'), 'its request holds what the tune-out held');
    assert.ok(!body.includes('PRE-1') && !body.includes('PRE-2'), 'and none of what came before it');

    // (b) A re-anchor moves the start forward, and a row stored before T1
    // enters the window again past everything (as one taken out and
    // presented again does: an undo and its redo). The next tune-out's enter
    // sets the start back to T1's kept ordinal, not to one worked out from
    // T1's sequence again, which would now start past that row and leave
    // T1's held rows out.
    h.strategy().setAnchorOrdinal(start + 1);
    const pre1 = h.rowOf('PRE-1 before the tune-out').id;
    cm.retractRows([pre1]);
    cm.presentRows([pre1]);
    assert.ok(cm.ordinalOf(pre1)! > ordinal('T1-HELD-2 chatter'), 'premise: it is in the window again, past the held rows');
    const scope = h.internals.tuneOutCoordinator.enterAllExcept({ serverId: 'disc', channelId: 'disc:guild:quiet' }, { durationSeconds: 3600 }, 'agent-tool');
    assert.ok(scope.ok, (scope as { error?: string }).error);
    assert.equal(h.strategy().getAnchorOrdinal(), start, "back at T1's ordinal exactly");
    assert.notEqual(cm.ordinalOf(reply.id), start, 'premise: converting T1 again would start at its reply');

    // (g) T1's cancel forgets its start.
    assert.ok(h.internals.tuneOutCoordinator.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
    assert.equal(h.windowStarts()?.[epochId], undefined, "T1's start is forgotten");
    await h.framework.runUntilIdle();
  });

  it('(c) is the same after a restart, though working it out from the tune-out again would give another', { timeout: 120_000 }, async () => {
    const dir = place();
    const first = await boot(dir);
    const { epochId, reply } = await enterDuringItsTurn(first);
    const before = first.strategy().getAnchorOrdinal();
    assert.equal(before, first.subCm().ordinalOf(first.rowOf('T1-HELD-1 chatter').id));
    assert.notEqual(first.subCm().ordinalOf(reply.id), before, 'premise: its reply is before the start');
    // A row stored before T1 in the window again, past the held rows (see (b)).
    const pre1 = first.rowOf('PRE-1 before the tune-out').id;
    first.subCm().retractRows([pre1]);
    first.subCm().presentRows([pre1]);
    await first.framework.stop();
    frameworks.splice(frameworks.indexOf(first.framework), 1);

    const second = await boot(dir);
    assert.equal(second.strategy().getAnchorOrdinal(), before, 'the start it had');
    assert.deepEqual(second.windowStarts(), { [epochId]: before }, 'set from what was kept');
  });

  it('(d) is set by sequence while the window is the record, as before, and keeps no ordinal', { timeout: 120_000 }, async () => {
    const h = await boot(place(), true);
    h.residentRow('before the tune-out');
    const entered = h.internals.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool');
    assert.ok(entered.ok);
    assert.equal(h.subCm().windowMode(), 'legacy', 'premise');
    assert.equal(h.strategy().getAnchor(), entered.params.startedAtSequence, "the tune-out's start, by sequence");
    assert.equal(h.strategy().getAnchorOrdinal(), undefined);
    assert.deepEqual(h.windowFixes(), []);
  });

  it('(f) gives a tune-out active at the upgrade its ordinal right after the window is written down, in record order', { timeout: 120_000 }, async () => {
    const dir = place();
    const legacy = await boot(dir, true);
    legacy.residentRow('OLD-1 before the tune-out');
    legacy.bump();
    const entered = legacy.internals.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool');
    assert.ok(entered.ok);
    const epochId = entered.params.epochId;
    legacy.residentRow('NEW-1 held', { tuneOut: { epochId } });
    legacy.residentRow('NEW-2 held', { tuneOut: { epochId } });
    await legacy.framework.runUntilIdle();
    const dry = { dryRun: true } as never;
    const before = (await legacy.subCm().compile(undefined, undefined, dry)).messages.map((m) => textOf(m as never));
    assert.ok(before.includes('NEW-1 held') && !before.includes('OLD-1 before the tune-out'), `premise: ${JSON.stringify(before)}`);
    await legacy.framework.stop();
    frameworks.splice(frameworks.indexOf(legacy.framework), 1);

    const h = await boot(dir);
    const cm = h.subCm();
    assert.equal(cm.windowMode(), 'presented', 'premise: written down at its registration');
    const first = cm.ordinalOf(h.rowOf('NEW-1 held').id)!;
    assert.equal(cm.ordinalOf(h.rowOf('OLD-1 before the tune-out').id)! + 1, first, 'premise: written down in record order');
    assert.equal(h.strategy().getAnchorOrdinal(), first, "the tune-out's first row");
    assert.deepEqual((await cm.compile(undefined, undefined, dry)).messages.map((m) => textOf(m as never)), before,
      'its window from there is the one the sequence gave');
    assert.deepEqual(h.windowStarts(), { [epochId]: first }, 'and kept, fixed as the coordinator resumed it');
  });
});

describe("the persistent subconscious's window start when the oldest tune-out ends first (review 2, J-AF30)", () => {
  // The start stayed at T1's while T2 stayed active, as a cancel leaves it,
  // but a restart set T2's (the oldest active then), so the rows between the
  // two starts left the window across the restart, T1's held rows with them,
  // and its prefix changed.
  it('(h) stays where it was at the cancel, and is the same after a restart', { timeout: 120_000 }, async () => {
    const dir = place();
    const first = await boot(dir);
    first.residentRow('PRE-1 before the tune-outs');
    first.bump();
    const t1 = first.internals.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool');
    assert.ok(t1.ok);
    first.residentRow('T1-HELD-1 chatter', { tuneOut: { epochId: t1.params.epochId } });
    first.residentRow('BETWEEN-1 after T1');
    first.bump();
    const t2 = first.internals.tuneOutCoordinator.enterAllExcept({ serverId: 'disc', channelId: 'disc:guild:quiet' }, { durationSeconds: 3600 }, 'agent-tool');
    assert.ok(t2.ok, (t2 as { error?: string }).error);
    first.residentRow('T2-HELD-1 chatter', { tuneOut: { epochId: t2.params.epochId } });
    await first.framework.runUntilIdle();
    const start = first.strategy().getAnchorOrdinal();
    assert.equal(start, first.subCm().ordinalOf(first.rowOf('T1-HELD-1 chatter').id), "premise: T1's start, the oldest");
    assert.ok(start! < first.subCm().ordinalOf(first.rowOf('BETWEEN-1 after T1').id)!, "premise: before T2's");

    assert.ok(first.internals.tuneOutCoordinator.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
    await first.framework.runUntilIdle();
    assert.equal(first.strategy().getAnchorOrdinal(), start, 'the cancel leaves the start where it was');
    const report = first.membrane.callsFor(SUB).at(-1)!;
    assert.ok(report.messages.some((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === 'T1-HELD-1 chatter')),
      'so its report on T1 reads the row T1 held, not only its line in the dump');
    const kept = first.internals.channelRegistry.readCoordinatorState(STARTS) as { starts: Record<string, number>; inForce?: number };
    const dry = { dryRun: true } as never;
    const before = (await first.subCm().compile(undefined, undefined, dry)).messages.map((m) => textOf(m as never));
    await first.framework.stop();
    frameworks.splice(frameworks.indexOf(first.framework), 1);

    const second = await boot(dir);
    assert.equal(second.strategy().getAnchorOrdinal(), start, "the start it had, not T2's");
    const after = (await second.subCm().compile(undefined, undefined, dry)).messages.map((m) => textOf(m as never));
    assert.deepEqual(after.slice(0, before.length), before, 'over the same window');
    assert.ok(after.includes('T1-HELD-1 chatter') && after.includes('BETWEEN-1 after T1'), `the rows between the starts stay in it: ${JSON.stringify(after)}`);
    assert.equal(kept.inForce, start, 'set from the start in force, kept at the cancel');
    assert.equal(kept.starts[t1.params.epochId], undefined, "while T1's own start was forgotten");

    // Once no tune-out is active, nothing is kept in force: the next enter sets its own.
    assert.ok(second.internals.tuneOutCoordinator.cancelAllExcept('agent-tool', 'test').ok);
    await second.framework.runUntilIdle();
    const none = second.internals.channelRegistry.readCoordinatorState(STARTS) as { starts: Record<string, number>; inForce?: number };
    assert.deepEqual(none.starts, {});
    assert.equal(none.inForce, undefined);
  });
});

describe("the persistent subconscious's window start of a tune-out entered while an older one holds it", () => {
  it('(i) is fixed as soon as it can be, so a row presented again ahead of it later leaves its held rows in the window', { timeout: 120_000 }, async () => {
    const h = await boot(place());
    h.residentRow('PRE-1 before the tune-outs');
    h.bump();
    const t1 = h.internals.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool');
    assert.ok(t1.ok);
    h.residentRow('T1-HELD-1 chatter', { tuneOut: { epochId: t1.params.epochId } });
    h.residentRow('BETWEEN-1 after T1');
    h.bump();
    const t2 = h.internals.tuneOutCoordinator.enterAllExcept({ serverId: 'disc', channelId: 'disc:guild:quiet' }, { durationSeconds: 3600 }, 'agent-tool');
    assert.ok(t2.ok, (t2 as { error?: string }).error);
    h.residentRow('T2-HELD-1 chatter', { tuneOut: { epochId: t2.params.epochId } });
    await h.framework.runUntilIdle();
    const cm = h.subCm();
    const between = h.rowOf('BETWEEN-1 after T1').id;
    const betweenAt = cm.ordinalOf(between)!;
    const t2First = cm.ordinalOf(h.rowOf('T2-HELD-1 chatter').id)!;
    assert.ok(betweenAt < t2First, 'premise: the row stored before T2 is ahead of its held row');

    cm.retractRows([between]);
    cm.presentRows([between]);
    assert.ok(cm.ordinalOf(between)! > t2First, 'premise: it is in the window again, past the held row');

    assert.ok(h.internals.tuneOutCoordinator.cancel('disc', CHANNEL, 'agent-tool', 'test').ok);
    await h.framework.runUntilIdle();
    const t3 = h.internals.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool');
    assert.ok(t3.ok, (t3 as { error?: string }).error);
    const start = h.strategy().getAnchorOrdinal()!;
    assert.ok(start > betweenAt && start <= t2First, `T2's start, as it was before the row came back (${betweenAt} < ${start} <= ${t2First})`);
    assert.equal(h.windowStarts()?.[t2.params.epochId], start, 'kept for T2');

    h.membrane.script(SUB, final([signed('sig-i'), text('>>skip_reply nothing yet')]));
    const calls = h.membrane.callsFor(SUB).length;
    h.ask();
    await waitFor('its next request', () => h.membrane.callsFor(SUB).length > calls);
    await h.framework.runUntilIdle();
    const body = JSON.stringify(h.membrane.callsFor(SUB).at(-1)!.messages);
    assert.ok(body.includes('T2-HELD-1 chatter'), 'its request holds what T2 held');
  });
});

describe('SubconsciousWindowAnchor', () => {
  /** A host over a window of `rows` (sequence and ordinal each), with the rows still owed. */
  function host(options: { presents?: boolean; rows?: Array<{ sequence: number; ordinal: number }>; owed?: number[]; length?: number }) {
    const calls: string[] = [];
    const fixed: Array<{ epochIds: readonly string[]; ordinal: number }> = [];
    const traces: unknown[] = [];
    const state = { owed: options.owed ?? [], rows: options.rows ?? [], setFails: 0, keepFails: 0 };
    const strategy: AnchoredStrategy = {
      setAnchor: (sequence) => { calls.push(`setAnchor(${sequence})`); },
      setAnchorOrdinal: (ordinal) => {
        calls.push(`setAnchorOrdinal(${ordinal})`);
        if (state.setFails > 0) { state.setFails--; throw new Error('the slot refused it'); }
      },
      getAnchorOrdinal: () => undefined,
    };
    const anchor = new SubconsciousWindowAnchor({
      agentName: SUB,
      cm: () => ({
        indexLength: () => options.length ?? state.rows.length,
        getPresentedMessages: () => state.rows.map((r) => ({ id: `r${r.ordinal}`, sequence: r.sequence }) as unknown as StoredMessage),
        ordinalOf: (id: string) => state.rows.find((r) => `r${r.ordinal}` === id)?.ordinal,
      }) as never,
      strategy: () => strategy,
      presents: () => options.presents ?? true,
      owed: () => state.owed.map((sequence) => ({ sequence })),
      fixed: (epochIds, ordinal) => {
        fixed.push({ epochIds, ordinal });
        if (state.keepFails > 0) { state.keepFails--; return false; }
        return true;
      },
      emitTrace: (event) => { traces.push(event); },
    });
    return { anchor, calls, fixed, traces, state };
  }

  it('(e) clamps a kept ordinal past the window to its length, and traces it', () => {
    const h = host({ length: 4 });
    h.anchor.set({ sequence: 50, ordinal: 9, epochIds: ['t1'] });
    assert.deepEqual(h.calls, ['setAnchorOrdinal(4)']);
    assert.deepEqual(h.traces, [{ type: 'tune-out:subconscious-window', agentName: SUB, epochIds: ['t1'], how: 'clamped', ordinal: 4, kept: 9 }]);
    assert.deepEqual(h.fixed, [], 'the kept ordinal stays kept');
  });

  it('sets by sequence in legacy mode, and fixes a start only once nothing owed is older', () => {
    const legacy = host({ presents: false });
    legacy.anchor.set({ sequence: 50, ordinal: 3, epochIds: ['t1'] });
    assert.deepEqual(legacy.calls, ['setAnchor(50)'], 'legacy mode goes by sequence, whatever is kept');

    // Rows 0-2 stored before 50; ordinal 1 (sequence 55) is the agent's own,
    // presented ahead of row 2.
    const h = host({ rows: [{ sequence: 10, ordinal: 0 }, { sequence: 55, ordinal: 1 }, { sequence: 20, ordinal: 2 }], owed: [30, 60] });
    h.anchor.set({ sequence: 50, epochIds: ['t1'] });
    assert.deepEqual(h.calls, ['setAnchor(50)'], 'for now by sequence');
    assert.deepEqual(h.fixed, [], 'a row stored before the start is still owed');
    h.state.owed = [60];
    h.state.rows.push({ sequence: 30, ordinal: 3 });
    h.anchor.presented();
    assert.deepEqual(h.fixed, [{ epochIds: ['t1'], ordinal: 4 }], 'fixed past the last row stored before the start');
    assert.deepEqual(h.calls, ['setAnchor(50)', 'setAnchorOrdinal(4)']);
    h.anchor.presented();
    assert.equal(h.fixed.length, 1, 'once');
  });

  it('a start set while the window is the record, and the other active ones, are fixed at its first presentation', () => {
    const options = { presents: false };
    const h = host(options);
    h.anchor.set({ sequence: 50, epochIds: ['t1'] }, [{ sequence: 70, epochIds: ['t2'] }]);
    assert.deepEqual(h.calls, ['setAnchor(50)'], 'by sequence while the window is the record');
    assert.deepEqual(h.fixed, [], 'and nothing fixed then');
    options.presents = true;
    h.state.rows.push({ sequence: 10, ordinal: 0 }, { sequence: 60, ordinal: 1 });
    h.anchor.presented();
    assert.deepEqual(h.fixed, [{ epochIds: ['t1'], ordinal: 1 }, { epochIds: ['t2'], ordinal: 2 }],
      'each fixed past the last row stored before its start, once the window presents');
    assert.deepEqual(h.calls, ['setAnchor(50)', 'setAnchorOrdinal(1)'], 'and only the start in force moves the window');
  });

  it('a start whose setting or keeping fails is set and kept at the next presentation, at the ordinal it was fixed at', () => {
    const failedSet = host({ rows: [{ sequence: 10, ordinal: 0 }] });
    failedSet.state.setFails = 1;
    const errors = console.error;
    console.error = () => {};
    try {
      failedSet.anchor.set({ sequence: 50, epochIds: ['t1'] });
    } finally { console.error = errors; }
    assert.deepEqual(failedSet.fixed, [], 'premise: the set failed, so nothing is kept');
    failedSet.state.rows.push({ sequence: 20, ordinal: 1 });
    failedSet.anchor.presented();
    assert.deepEqual(failedSet.calls, ['setAnchor(50)', 'setAnchorOrdinal(1)', 'setAnchorOrdinal(1)'], 'set again at the ordinal it was fixed at');
    assert.deepEqual(failedSet.fixed, [{ epochIds: ['t1'], ordinal: 1 }], 'and kept');

    const failedKeep = host({ rows: [{ sequence: 10, ordinal: 0 }] });
    failedKeep.state.keepFails = 1;
    failedKeep.anchor.set({ sequence: 50, epochIds: ['t1'] });
    assert.deepEqual(failedKeep.fixed, [{ epochIds: ['t1'], ordinal: 1 }], 'premise: its keeping failed once');
    failedKeep.state.rows.push({ sequence: 20, ordinal: 1 });
    failedKeep.anchor.presented();
    assert.deepEqual(failedKeep.fixed, [{ epochIds: ['t1'], ordinal: 1 }, { epochIds: ['t1'], ordinal: 1 }], 'kept at the next presentation, at the same ordinal');
    failedKeep.anchor.presented();
    assert.equal(failedKeep.fixed.length, 2, 'and then no more');
  });
});
