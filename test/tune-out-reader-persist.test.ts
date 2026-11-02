/**
 * A persisted reader (`subconscious.persist`, design note §3 option C): with
 * reader forks, `'epoch'` or `'resident'` makes the reader one derived
 * identity. Its first look in the scope derives it as a fork is derived; each
 * later look resumes it (a new incarnation on its own branch) and hands it
 * what the resident's window took since its last look, as framing. Left out,
 * or `'look'`, each look derives a fork of its own, as before.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageId, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { AgentFramework, WorkspaceModule, defaultReaderFraming } from '../src/index.js';
import type { FrameworkConfig, ReaderFramingContext, TraceEvent } from '../src/index.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { WireMembrane, final } from './helpers/wire-membrane.js';
import { GateModule, waitCall } from './helpers/dendrite.js';
import { tuneOutTool } from '../src/framework.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

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
  store: {
    listBranches(): Array<{ name: string }>;
    currentBranch(): { name: string };
    currentSequence(): number;
    createBranchAt(name: string, from: string, at: number): unknown;
  };
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('a persisted reader: configuration', () => {
  const create = async (subconscious: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-cfg-'));
    dirs.push(dir);
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'x' }],
      subconscious: { enabled: true, reader: 'forks', model: 'test-model', voice: 'read', ...subconscious } as never,
      modules: [],
    });
    frameworks.push(framework);
    return framework;
  };

  it('takes each persist and resync mode, and a pendingRound object or function', async () => {
    for (const persist of ['look', 'epoch', 'resident']) await create({ persist });
    for (const resync of ['window', 'none']) await create({ persist: 'epoch', resync });
    await create({ pendingRound: { include: false } });
    await create({ pendingRound: () => ({ madeBy: { result: 'host text' } }) });
  });

  it('refuses a persist, resync or pendingRound it has no mode for', async () => {
    await assert.rejects(create({ persist: 'forever' }), /subconscious\.persist must be 'look', 'epoch' or 'resident', not another string/);
    await assert.rejects(create({ persist: 'epoch', resync: 'all' }), /subconscious\.resync must be 'window' or 'none', not another string/);
    await assert.rejects(create({ pendingRound: 'none' }), /subconscious\.pendingRound must be an object, as deriveAgent's pendingRound takes it, or a function/);
    await assert.rejects(create({ pendingRound: [] }), /subconscious\.pendingRound must be an object/);
  });
});

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
  /** A look the coordinator would ask for, handed `backlog`. */
  const look = (epochId: string, backlog: StoredMessage[], trigger: Invocation['trigger'] = 'cadence', extraFields: Partial<Invocation> = {}) =>
    internals.invokeReaderFork({ serverId: 'disc', channelId: CHANNEL, epochId, trigger, notice: `[Tune-out ${trigger}: test]`, backlog, dispositions: null, ...extraFields });
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
  const forkTraces = () => traces.filter((t) => t.type === 'tune-out:reader-fork') as Array<TraceEvent & {
    agentName: string; held: number; incarnation?: number; resumed?: boolean; resynced?: number; trigger: string;
  }>;
  /** Wait for the look that makes `name`'s record reach `incarnation` to end. */
  const looked = async (name: string, incarnation: number) => {
    await waitFor(`${name} incarnation ${incarnation} ended`, () => {
      const record = framework.getAgentRecord(name);
      return !!record?.ended && record.incarnation === incarnation;
    });
    await framework.runUntilIdle();
  };
  return { framework, membrane, traces, internals, scout, rows, hold, look, residentTurn, enter, forkTraces, looked };
}

describe('a persisted reader: one identity, resumed at each look', () => {
  it('derives at the first look in the epoch and resumes the same identity at the next: a new incarnation, no new derivation', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-'));
    dirs.push(dir);
    const t = await boot(dir, { persist: 'epoch' });
    await t.residentTurn('hello scout', 'scout hears you');
    const epochId = t.enter();
    const name = `reader/scout/${epochId.slice(0, 8)}/g1`;

    t.membrane.script('reader', final([text('First look: one held message.')]));
    t.look(epochId, [t.hold(epochId, 'HELD-1 chatter')]);
    await t.looked(name, 1);
    t.membrane.script('reader', final([text('Second look: one more.')]));
    t.look(epochId, [t.hold(epochId, 'HELD-2 more chatter')]);
    await t.looked(name, 2);

    assert.deepEqual(t.forkTraces().map((f) => [f.agentName, f.incarnation, f.resumed, f.held]),
      [[name, 1, false, 1], [name, 2, true, 1]], 'one name, incarnation 1 derived, then 2 resumed');
    const created = t.traces.filter((e) => e.type === 'dendrite:agent-created' && (e as { agentName: string }).agentName.startsWith('reader/')) as Array<TraceEvent & { agentName: string; incarnation: number; inherit?: { ownBranch?: string } }>;
    assert.deepEqual(created.map((c) => [c.agentName, c.incarnation]), [[name, 1], [name, 2]],
      'a creation event per incarnation, and one derivation (incarnation 1) only');
    assert.equal(created[1]!.inherit?.ownBranch, created[0]!.inherit?.ownBranch, 'the resumption is on the branch the derivation made');
    assert.deepEqual(t.internals.store.listBranches().map((b) => b.name).filter((b) => b.startsWith('dendrite/reader/')), [`dendrite/${name}`],
      'no second branch: nothing was derived again');
    assert.deepEqual(t.framework.listAgents({ includeEnded: true }).filter((r) => r.kind === 'subconscious-fork').map((r) => [r.name, r.incarnation]),
      [[name, 1], [name, 2]], 'an ended record per incarnation, of the one identity');

    const record = t.framework.getAgentRecord(name)!;
    assert.equal(record.kind, 'subconscious-fork', 'the dispatch restriction keys on the kind, which the resumption keeps');
    assert.equal(record.inherit?.refusals, true);
    assert.equal(record.onParentEnd, 'end');
    assert.deepEqual(record.relationships.resultTo, { to: 'scout', as: 'message' });
    assert.deepEqual(record.metadata, {
      epochId, channelId: CHANNEL, trigger: 'cadence', persist: 'epoch', resync: 'window',
      residentBranch: t.internals.store.currentBranch().name,
    }, "this incarnation's metadata");

    // Its second request continues its first: its own first framing and
    // reply, then the second framing.
    const [first, second] = t.membrane.callsFor('reader');
    assert.ok(first && second, 'two reader requests');
    const plain = (r: NormalizedRequest) => r.messages.map(({ participant, content }) => ({ participant, content: JSON.stringify(content).replace(/"cacheBreakpoint":true,?/g, '') }));
    assert.deepStrictEqual(plain(second).slice(0, first.messages.length), plain(first), 'the first request is a prefix of the second');
    const after = second.messages.slice(first.messages.length).map((m) => textOf(m as never));
    assert.ok(after[0]!.includes('First look: one held message.'), "then the reader's own reply");
    assert.ok(after.at(-1)!.includes('HELD-2 more chatter') && !after.at(-1)!.includes('HELD-1'), 'and last the second framing, with the second held message alone');

    // Both reports reach scout as mail from the one identity, by incarnation.
    const mail = t.rows().filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'agent-result');
    assert.deepEqual(mail.map((m) => (m.metadata as { dendrite: { from: unknown } }).dendrite.from), [{ agent: name, incarnation: 1 }, { agent: name, incarnation: 2 }]);
  });

  it('runs one look at a time per identity: a look asked for while one runs waits for it', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-serial-'));
    dirs.push(dir);
    const t = await boot(dir, { persist: 'resident' });
    const epochId = t.enter();
    const name = 'reader/scout/g1';
    let release!: () => void;
    t.membrane.hold('reader', new Promise<void>((r) => { release = r; }));
    t.look(epochId, [t.hold(epochId, 'HELD-1')]);
    await waitFor('the first look is running', () => t.membrane.callsFor('reader').length === 1);
    t.look(epochId, [t.hold(epochId, 'HELD-2')]);
    t.look(epochId, [t.hold(epochId, 'HELD-3')]);
    await new Promise((r) => setTimeout(r, 300));
    const whileHeld = {
      looks: t.forkTraces().map((f) => f.agentName),
      failed: t.traces.filter((e) => e.type === 'tune-out:reader-fork-failed').length,
    };
    release();
    assert.deepEqual(whileHeld, { looks: [name], failed: 0 },
      'the later looks wait: neither is derived or resumed while the first runs, and neither fails on a name still registered');
    await t.looked(name, 3);
    assert.deepEqual(t.forkTraces().map((f) => [f.agentName, f.incarnation, f.resumed]), [[name, 1, false], [name, 2, true], [name, 3, true]]);
    assert.equal(t.traces.some((e) => e.type === 'tune-out:reader-fork-failed'), false);
  });

  it('after a restart, resumes the identity from its ended record', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-restart-'));
    dirs.push(dir);
    const first = await boot(dir, { persist: 'epoch' });
    const epochId = first.enter();
    const name = `reader/scout/${epochId.slice(0, 8)}/g1`;
    first.membrane.script('reader', final([text('Before the restart.')]));
    first.look(epochId, [first.hold(epochId, 'HELD-1 before')]);
    await first.looked(name, 1);
    await first.framework.stop();
    frameworks.splice(frameworks.indexOf(first.framework), 1);

    const second = await boot(dir, { persist: 'epoch' });
    assert.ok(second.framework.listPolicyEpochs().some((e) => e.id === epochId), 'premise: the tune-out is in force after the restart');
    assert.equal(second.framework.getAgentRecord(name)?.ended?.reason, 'completed', 'premise: the ended record is there');
    second.membrane.script('reader', final([text('After the restart.')]));
    second.look(epochId, [second.hold(epochId, 'HELD-2 after')]);
    await second.looked(name, 2);
    assert.deepEqual(second.forkTraces().map((f) => [f.agentName, f.incarnation, f.resumed]), [[name, 2, true]], 'resumed, not derived');
    assert.equal(second.traces.some((e) => e.type === 'tune-out:reader-rederived'), false);
    const request = second.membrane.callsFor('reader')[0]!;
    const body = JSON.stringify(request.messages);
    assert.ok(body.includes('HELD-1 before') && body.includes('Before the restart.'), 'its request holds what it was handed and said before the restart');
  });
});

describe('a persisted reader: re-synced by framing', () => {
  it("hands a resumed look the rows the resident's context took since its last look, and none from before", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-resync-'));
    dirs.push(dir);
    const contexts: ReaderFramingContext[] = [];
    const t = await boot(dir, { persist: 'epoch', framing: (ctx: ReaderFramingContext) => { contexts.push(ctx); return defaultReaderFraming(ctx); } });
    await t.residentTurn('EARLY-1 hello scout', 'EARLY-2 scout hears you');
    const epochId = t.enter();
    const name = `reader/scout/${epochId.slice(0, 8)}/g1`;
    const windowEnd = () => t.scout().getContextManager().indexLength();

    // The first look: derived, its inheritance the resident's whole window.
    t.membrane.script('reader', final([text('READER-REPORT-1 one held message.')]));
    t.membrane.script('scout', final([text('LATE-0 noted the report')]));
    const endAtFirst = windowEnd();
    t.look(epochId, [t.hold(epochId, 'HELD-1 chatter')]);
    await t.looked(name, 1);
    await waitFor("scout's turn on the report", () => t.rows().some((m) => textOf(m) === 'LATE-0 noted the report'));
    await t.residentTurn('LATE-1 what about the build?', 'LATE-2 the build is green');

    // The second look: resumed, handed what scout's context took since.
    t.membrane.script('reader', final([text('READER-REPORT-2 nothing more.')]));
    t.look(epochId, [t.hold(epochId, 'HELD-2 more chatter')]);
    await t.looked(name, 2);

    assert.equal(contexts[0]!.residentRows, undefined, 'a derivation is handed no rows: it holds the window');
    assert.equal(contexts[0]!.resumed, false);
    const framings = (await t.framework.inspectAgentContext(name)).getAllMessages()
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'tune-out-reader-framing');
    const marks = framings.map((m) => (m.metadata as { residentThrough?: number; residentBranch?: string }));
    assert.equal(marks[0]!.residentThrough, endAtFirst - 1, "the first framing records the resident's window as derived: the last ordinal it held");

    // Exactly what scout's window took after that mark, up to the second's,
    // in window order, but the reader's own report mail.
    const cm = t.scout().getContextManager();
    const reportMail = (m: StoredMessage) => (m.metadata as { dendrite?: { from?: { agent?: string } } } | undefined)?.dendrite?.from?.agent === name;
    const expected = cm.getPresentedMessages()
      .filter((m) => { const at = cm.ordinalOf(m.id) as unknown as number; return at > marks[0]!.residentThrough! && at <= marks[1]!.residentThrough!; });
    assert.ok(expected.some(reportMail), "premise: the reader's first report entered scout's window between the looks");
    const handed = contexts[1]!.residentRows!;
    assert.deepEqual(handed.map((m) => m.id), expected.filter((m) => !reportMail(m)).map((m) => m.id),
      "scout's window's rows between the marks, in window order, without the reader's own report mail");
    const texts = handed.map((m) => textOf(m));
    assert.deepEqual(texts.filter((h) => h.startsWith('LATE-')), ['LATE-0 noted the report', 'LATE-1 what about the build?', 'LATE-2 the build is green']);
    assert.ok(!texts.some((h) => h.includes('EARLY')), 'and none from before the first look, which its inheritance holds');
    assert.equal(t.forkTraces()[1]!.resynced, handed.length);
    assert.equal(marks[0]!.residentBranch, t.internals.store.currentBranch().name);
    assert.ok(marks[1]!.residentThrough! > marks[0]!.residentThrough!, 'and the second, where it stood at the second look');
    assert.equal(t.framework.getAgentRecord(name)!.metadata!.residentBranch, t.internals.store.currentBranch().name, 'the record says where the look was framed');

    // The default framing writes them as one factual block.
    const sent = JSON.stringify(t.membrane.callsFor('reader')[1]!.messages.at(-1));
    assert.ok(sent.includes(`[In scout's context since your last look: ${handed.length} messages]`), sent);
    assert.ok(sent.includes('scout: LATE-0 noted the report') && sent.includes('antra: LATE-1 what about the build?') && sent.includes('scout: LATE-2 the build is green'), sent);
  });

  it('does not hand a resumed look a held row its own branch holds already', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-dedupe-'));
    dirs.push(dir);
    const t = await boot(dir, { persist: 'epoch' });
    const epochId = t.enter();
    const name = `reader/scout/${epochId.slice(0, 8)}/g1`;
    const first = t.hold(epochId, 'HELD-1 chatter');
    t.look(epochId, [first]);
    await t.looked(name, 1);
    // As after a restart, when the coordinator's cursor is gone: the
    // epoch's whole backlog, the row handed before included.
    const second = t.hold(epochId, 'HELD-2 more chatter');
    t.look(epochId, [first, second]);
    await t.looked(name, 2);
    assert.deepEqual(t.forkTraces().map((f) => f.held), [1, 1], 'handed the new row alone');
    const framings = (await t.framework.inspectAgentContext(name)).getAllMessages()
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'tune-out-reader-framing');
    assert.deepEqual(framings.map((m) => (m.metadata as { heldMessageIds: string[] }).heldMessageIds), [[first.id], [second.id]]);
    const last = JSON.stringify(t.membrane.callsFor('reader')[1]!.messages.at(-1));
    assert.ok(last.includes('HELD-2') && !last.includes('HELD-1'), last);
  });

  it("writes the resident's rows as a count line and a line per row: calls and results in brief, no thinking", () => {
    const row = (participant: string, content: unknown[], metadata: Record<string, unknown> = {}) =>
      ({ id: `r-${Math.random()}`, sequence: 0, participant, content, metadata }) as unknown as StoredMessage;
    const ctx: ReaderFramingContext = {
      resident: 'scout', fork: 'reader/scout/g1', voice: 'Read for scout.', channelId: CHANNEL, epochId: 'abcdef0123', trigger: 'cadence',
      notice: '[Tune-out cadence: test]', dispositions: null, backlog: [], resumed: true, incarnation: 2,
      residentRows: [
        row('user', [{ type: 'text', text: 'is the build green?' }], { author: { id: 'u1', name: 'antra' } }),
        row('scout', [{ type: 'thinking', thinking: 'SECRET-THOUGHT', signature: 's' }, { type: 'text', text: 'checking' }, { type: 'tool_use', id: 'c1', name: 'ci--status', input: { branch: 'main' } }]),
        row('user', [{ type: 'tool_result', toolUseId: 'c1', content: 'green' }]),
        row('user', [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } }], { author: { id: 'u1', name: 'antra' } }),
      ],
    };
    const out = defaultReaderFraming(ctx);
    const all = out.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    assert.ok(all.includes("[In scout's context since your last look: 4 messages]\nantra: is the build green?\nscout: checking\n[ci--status called: {\"branch\":\"main\"}]\n[ci--status returned: green]"), all);
    assert.ok(!all.includes('SECRET-THOUGHT'), 'no thinking');
    assert.equal(out.filter((b) => b.type === 'image').length, 1, 'media as it is');
    assert.ok(all.endsWith('[Nothing new has been held since your last look.]'), 'the held block after it, as before');
    const none = defaultReaderFraming({ ...ctx, residentRows: [] }).map((b) => (b as { text?: string }).text ?? '').join('\n');
    assert.ok(none.includes("[Nothing has entered scout's context since your last look.]"), none);
    const { residentRows: _rows, resumed: _r, incarnation: _i, ...look } = ctx;
    assert.deepEqual(defaultReaderFraming(look), defaultReaderFraming({ ...look }), 'premise');
    assert.ok(!JSON.stringify(defaultReaderFraming(look)).includes("scout's context"), "without residentRows there's no block");
  });
});

describe('a persisted reader: derived again, and when not', () => {
  const rederived = (traces: TraceEvent[]) => traces.filter((e) => e.type === 'tune-out:reader-rederived')
    .map((e) => { const r = e as unknown as { agentName: string; previous: string; reason: string }; return [r.previous, r.agentName, r.reason]; });

  it("derives it again when its checkpoint is no longer on the host's branch", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-branch-'));
    dirs.push(dir);
    const t = await boot(dir, { persist: 'epoch' });
    const epochId = t.enter();
    const g = (k: number) => `reader/scout/${epochId.slice(0, 8)}/g${k}`;
    const trunk = t.internals.store.currentBranch().name;
    const first = t.hold(epochId, 'HELD-1');
    const beforeLook = t.internals.store.currentSequence();
    t.look(epochId, [first]);
    await t.looked(g(1), 1);
    t.internals.store.createBranchAt('side', trunk, beforeLook);
    await t.framework.switchBranch('side');
    t.look(epochId, [t.hold(epochId, 'HELD-2 on the side branch')]);
    await t.looked(g(2), 1);
    assert.deepEqual(rederived(t.traces), [[g(1), g(2), 'branch-moved']]);
    assert.deepEqual(t.forkTraces().map((f) => [f.agentName, f.incarnation, f.resumed]), [[g(1), 1, false], [g(2), 1, false]]);
    assert.equal(t.framework.getAgentRecord(g(2))!.inherit?.branch, 'side', "derived from the resident on the host's branch now");
    assert.equal(t.framework.getAgentRecord(g(1))!.incarnation, 1, 'the earlier generation is not resumed');
  });

  it("with resync 'window', derives it again when its last look was framed on another branch; with 'none', resumes it", { timeout: 180_000 }, async () => {
    for (const resync of ['window', 'none'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `reader-persist-mark-${resync}-`));
      dirs.push(dir);
      const t = await boot(dir, { persist: 'resident', resync });
      const epochId = t.enter();
      const trunk = t.internals.store.currentBranch().name;
      t.look(epochId, [t.hold(epochId, 'HELD-1')]);
      await t.looked('reader/scout/g1', 1);
      // A branch made after the look: the checkpoint is on it, the mark's branch is not.
      t.internals.store.createBranchAt('later', trunk, t.internals.store.currentSequence());
      await t.framework.switchBranch('later');
      t.look(epochId, [t.hold(epochId, 'HELD-2')]);
      if (resync === 'window') {
        await t.looked('reader/scout/g2', 1);
        assert.deepEqual(rederived(t.traces), [['reader/scout/g1', 'reader/scout/g2', 'branch-moved']], resync);
      } else {
        await t.looked('reader/scout/g1', 2);
        assert.deepEqual(rederived(t.traces), [], resync);
        assert.equal(t.forkTraces()[1]!.resumed, true);
      }
      await t.framework.stop();
      frameworks.splice(frameworks.indexOf(t.framework), 1);
    }
  });

  it("with 'epoch', resumes it for the tune-out's own cancel look and derives it again for a look asked for after the tune-out ended", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-scope-'));
    dirs.push(dir);
    const t = await boot(dir, { persist: 'epoch' });
    const epochId = t.enter();
    const g = (k: number) => `reader/scout/${epochId.slice(0, 8)}/g${k}`;
    const first = t.hold(epochId, 'HELD-1');
    t.look(epochId, [first]);
    await t.looked(g(1), 1);
    const second = t.hold(epochId, 'HELD-2');
    // The coordinator's own cancel: the tune-out's state is gone by the time
    // it asks for its last look, which is still one of its looks.
    assert.deepEqual(t.internals.tuneOutCoordinator.cancel('disc', CHANNEL, 'agent-tool', 'test cancel'), { ok: true });
    await t.looked(g(1), 2);
    const cancelLook = t.forkTraces()[1]!;
    assert.deepEqual([cancelLook.agentName, cancelLook.trigger, cancelLook.resumed, cancelLook.held], [g(1), 'cancel', true, 1],
      'resumed for the cancel, and handed HELD-2 alone: its branch holds HELD-1, which the coordinator, never told of it here, hands again');
    // A reader that failed after the end has what it was handed go to one
    // late look, which the coordinator marks as asked for after the end.
    assert.equal(t.internals.tuneOutCoordinator.readerFailed({ serverId: 'disc', channelId: CHANNEL, epochId, backlog: [second] }), 1);
    await t.looked(g(2), 1);
    assert.deepEqual(rederived(t.traces), [[g(1), g(2), 'scope-ended']]);
    assert.equal(t.forkTraces()[2]!.trigger, 'cancel');
  });

  it("with 'resident', resumes it for a look asked for after its tune-out ended", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-scope-resident-'));
    dirs.push(dir);
    const t = await boot(dir, { persist: 'resident' });
    const epochId = t.enter();
    t.look(epochId, [t.hold(epochId, 'HELD-1')]);
    await t.looked('reader/scout/g1', 1);
    t.look(epochId, [t.hold(epochId, 'HELD-2')], 'cancel', { epochEnded: true });
    await t.looked('reader/scout/g1', 2);
    assert.deepEqual(rederived(t.traces), []);
  });

  it('asks for no second late look when the late look after the tune-out ended fails', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-late-'));
    dirs.push(dir);
    let refuse = false;
    const t = await boot(dir, { persist: 'resident' }, {
      dendrite: { beforeDerive: (spec: { name: string }) => (refuse && spec.name.startsWith('reader/') ? { refuse: 'refused by the test' } : undefined) },
    } as never);
    const epochId = t.enter();
    const first = t.hold(epochId, 'HELD-1');
    t.look(epochId, [first]);
    await t.looked('reader/scout/g1', 1);
    refuse = true;
    assert.deepEqual(t.internals.tuneOutCoordinator.cancel('disc', CHANNEL, 'agent-tool', 'test cancel'), { ok: true });
    // The cancel look's refusal came after the end, so one late look is
    // asked for, and its own refusal must end there.
    await waitFor("the cancel look's and the late look's refusals", () => t.traces.filter((e) => e.type === 'tune-out:reader-fork-failed').length >= 2);
    await new Promise((r) => setTimeout(r, 500));
    const failed = t.traces.filter((e) => e.type === 'tune-out:reader-fork-failed') as unknown as Array<{ returned: number; trigger: string }>;
    assert.equal(failed.length, 2, 'the cancel look and one late look, and no third');
    assert.equal(failed[1]!.returned, 0, "the late look's rows go nowhere: it was the last reader they had");
  });

  it('derives it again when its name has no ended record: a derivation whose run was refused', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-norecord-'));
    dirs.push(dir);
    const t = await boot(dir, { persist: 'epoch' });
    const epochId = t.enter();
    const g = (k: number) => `reader/scout/${epochId.slice(0, 8)}/g${k}`;
    await t.framework.quiesce({ reason: 'test' });
    t.look(epochId, [t.hold(epochId, 'HELD-1')]);
    await waitFor('the refused look', () => t.traces.some((e) => e.type === 'tune-out:reader-fork-failed'));
    assert.equal(t.framework.getAgentRecord(g(1)), null, 'premise: derived, its run refused, never registered');
    await t.framework.resume();
    t.look(epochId, [t.hold(epochId, 'HELD-2')]);
    await t.looked(g(2), 1);
    assert.deepEqual(rederived(t.traces), [[g(1), g(2), 'no-record']]);
  });

  it('asks beforeDerive at every derivation and every resumption, and a refused resumption is a failed look, never a derivation', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-refused-'));
    dirs.push(dir);
    const specs: Array<{ name: string; ownBranch?: string; metadata?: Record<string, unknown> }> = [];
    let refuse = false;
    const t = await boot(dir, { persist: 'epoch' }, {
      dendrite: {
        beforeDerive: (spec: { name: string; inherit?: { ownBranch?: string }; metadata?: Record<string, unknown> }) => {
          if (!spec.name.startsWith('reader/')) return undefined;
          specs.push({ name: spec.name, ...(spec.inherit?.ownBranch ? { ownBranch: spec.inherit.ownBranch } : {}), ...(spec.metadata ? { metadata: spec.metadata } : {}) });
          return refuse ? { refuse: 'refused by the test' } : undefined;
        },
      },
    } as never);
    const epochId = t.enter();
    const name = `reader/scout/${epochId.slice(0, 8)}/g1`;
    t.look(epochId, [t.hold(epochId, 'HELD-1')]);
    await t.looked(name, 1);
    t.look(epochId, [t.hold(epochId, 'HELD-2')], 'wake');
    await t.looked(name, 2);
    refuse = true;
    t.look(epochId, [t.hold(epochId, 'HELD-3')]);
    await waitFor('the refused resumption', () => t.traces.some((e) => e.type === 'tune-out:reader-fork-failed'));
    await t.framework.runUntilIdle();

    assert.deepEqual(specs.map((s) => [s.name, s.ownBranch !== undefined, s.metadata?.trigger, s.metadata?.persist]),
      [[name, false, 'cadence', 'epoch'], [name, true, 'wake', 'epoch'], [name, true, 'cadence', 'epoch']],
      "the derivation's spec, then each resumption's, with that look's metadata");
    const failed = t.traces.find((e) => e.type === 'tune-out:reader-fork-failed') as unknown as { agentName: string; error: string; returned: number };
    assert.equal(failed.agentName, name);
    assert.match(failed.error, /was not resumed: refused by the test/);
    assert.equal(failed.returned, 1, 'its held row goes back to the next reader');
    assert.deepEqual(rederived(t.traces), [], 'not derived again in its place');
    assert.equal(t.forkTraces().length, 2);
    assert.equal(t.framework.getAgentRecord(name)!.incarnation, 2, 'no incarnation began');
    assert.ok(!t.framework.listAgents({ includeEnded: true }).some((r) => r.name !== name && r.kind === 'subconscious-fork'));
  });
});

describe('a persisted reader: what the resident and the reader are told', () => {
  const lifecycle = (rows: StoredMessage[]) => rows.filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'agent-lifecycle');

  it("tells the resident, with a derivationNotice, what a re-synced reader reads, and counts resumptions toward the collapse", { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-notice-'));
    dirs.push(dir);
    const t = await boot(dir, { persist: 'resident' }, {
      dendrite: { derivationNotice: (_record: unknown, _from: string, line: string) => line, collapseDerivationNoticesAfter: 2 },
    } as never);
    const epochId = t.enter();
    for (let n = 1; n <= 4; n++) {
      t.look(epochId, [t.hold(epochId, `HELD-${n}`)]);
      await t.looked('reader/scout/g1', n);
    }
    const told = lifecycle(t.rows());
    assert.deepEqual(told.map((m) => (m.metadata as { dendrite: { incarnation: number } }).dendrite.incarnation), [1, 2, 4],
      'a line each for the first two, none for the third, a count line at the fourth');
    assert.equal(textOf(told[0]!),
      '[Agent lifecycle: reader/scout/g1 was derived from you as a subconscious-fork on your weights (test-model), reading your ' +
      'context up to this point, and handed what entered your context after it at each later look; its result returns to you ' +
      'as a message; it ends when its task does (idle 10 min), and ends with you.]');
    assert.equal(textOf(told[1]!),
      '[Agent lifecycle: reader/scout/g1 was resumed (incarnation 2) as a subconscious-fork on your weights (test-model), reading ' +
      'your context up to the point it was derived, and handed what entered your context after it at each look; its result ' +
      'returns to you as a message; it ends when its task does (idle 10 min), and ends with you.]');
    assert.match(textOf(told[2]!), /^\[Agent lifecycle: 1 subconscious-fork has been derived from you, and resumed 3 times, since \d\d:\d\d UTC \(2 since the last note\); the latest, reader\/scout\/g1, is a subconscious-fork/);
    assert.deepEqual((told[2]!.metadata as { dendrite: { collapsed: unknown } }).dendrite.collapsed, { count: 4, sinceLastNote: 2, resumed: 3 });
  });

  it("says in the tune_out tool what a persisted reader does at a later run, and nothing for a fork per look", () => {
    const later = (reader: Parameters<typeof tuneOutTool>[0]) => tuneOutTool(reader).description;
    const fork = 'A reader reads it instead: a fork of your context, run on a cadence and when a message there mentions you, ' +
      'which can report to you in its own words and cancel the tune-out. ';
    assert.ok(later({ kind: 'forks', persist: 'epoch', resync: 'window' }).includes(fork +
      'Within one tune-out, later runs resume that fork, each handed what entered your context since the run before; ' +
      'a new fork is made only when it can\'t be resumed. People who mention you'));
    assert.ok(later({ kind: 'forks', persist: 'resident', resync: 'none' }).includes(fork +
      'Later runs resume that fork, across tune-outs; a new fork is made only when it can\'t be resumed. People who mention you'));
    assert.ok(later({ kind: 'forks' }).includes(fork + 'People who mention you'), 'a fork per look: as before');
    for (const persist of ['epoch', 'resident'] as const) {
      assert.ok(!/subconscious|judg/i.test(JSON.stringify(tuneOutTool({ kind: 'forks', persist, resync: 'window' }))));
    }
    const framework = Object.create(AgentFramework.prototype) as {
      subconsciousAgentName: string | null; readerForks: boolean; subconsciousConfig: unknown; tuneOutToolDefinition(): ReturnType<typeof tuneOutTool>;
    };
    framework.subconsciousAgentName = null;
    framework.readerForks = true;
    framework.subconsciousConfig = { enabled: true, reader: 'forks', model: 'm', voice: 'v', persist: 'resident' };
    assert.deepEqual(framework.tuneOutToolDefinition(), tuneOutTool({ kind: 'forks', persist: 'resident', resync: 'window' }));
    framework.subconsciousConfig = { enabled: true, reader: 'forks', model: 'm', voice: 'v', persist: 'look' };
    assert.deepEqual(framework.tuneOutToolDefinition(), tuneOutTool({ kind: 'forks' }));
  });

  it("lets the host word the result of the resident's open call a reader is derived beside (pendingRound)", { timeout: 180_000 }, async () => {
    for (const persist of [undefined, 'epoch'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `reader-persist-round-${persist ?? 'unset'}-`));
      dirs.push(dir);
      const gates = new GateModule();
      const seen: string[] = [];
      const t = await boot(dir, {
        ...(persist ? { persist } : {}),
        pendingRound: (ctx: ReaderFramingContext) => { seen.push(ctx.fork); return { madeBy: { result: `[host: ${ctx.fork} reads for ${ctx.resident}]` } }; },
      }, { modules: [gates] } as never);
      const epochId = t.enter();
      t.membrane.script('scout', waitCall('g1'), final([text('scout is done waiting')]));
      t.internals.addMessage('antra', [text('wait for it')], { author: { id: 'u1', name: 'antra' } }, { forAgent: 'scout' });
      t.internals.pendingRequests.push({ agentName: 'scout', reason: 'test', source: 'test', timestamp: Date.now() });
      await waitFor('scout waits on its call', () => gates.entered.has('g1'));
      t.look(epochId, [t.hold(epochId, 'HELD-1')]);
      await waitFor("the reader's request", () => t.membrane.callsFor('reader').length === 1);
      const fork = seen[0]!;
      const round = (await t.framework.inspectAgentContext(fork)).getAllMessages()
        .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'dendrite-pending-round');
      const result = round.flatMap((m) => m.content).find((b) => b.type === 'tool_result') as { content: unknown } | undefined;
      assert.equal(result?.content, `[host: ${fork} reads for scout]`, `${persist ?? 'persist unset'}: the host's words, not the framework's note`);
      gates.release('g1');
      await t.framework.runUntilIdle();
      await t.framework.stop();
      frameworks.splice(frameworks.indexOf(t.framework), 1);
    }
  });

  it("shows a resumed reader the resident's tool presentation, as its derivation did", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-surface-'));
    dirs.push(dir);
    const board = mkdtempSync(join(tmpdir(), 'reader-persist-board-'));
    dirs.push(board);
    // scout's presentation hides a tool and rewords another, so a block
    // built without it differs.
    writeFileSync(join(board, 'tools.json'), JSON.stringify({ version: 1, tools: { journal: { visible: false }, think: { description: 'SCOUT-WORDED think' } } }));
    const t = await boot(dir, { persist: 'resident' }, {
      agents: [{
        name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled',
        toolPresentation: { path: join(board, 'tools.json'), cataloguePath: 'board/tools.md' },
      }],
      modules: [new WorkspaceModule({ mounts: [{ name: 'board', path: board, mode: 'read-write', watch: 'never' }] })],
    } as never);
    await t.residentTurn('hello scout', 'scout hears you');
    const epochId = t.enter();
    t.look(epochId, [t.hold(epochId, 'HELD-1')]);
    await t.looked('reader/scout/g1', 1);
    t.look(epochId, [t.hold(epochId, 'HELD-2')]);
    await t.looked('reader/scout/g1', 2);
    const tools = (r: NormalizedRequest) => JSON.stringify(r.tools ?? []);
    const resident = tools(t.membrane.callsFor('scout')[0]!);
    assert.ok(!resident.includes('"journal"') && resident.includes('SCOUT-WORDED think'), "premise: scout's presentation shapes its block");
    const [derived, resumed] = t.membrane.callsFor('reader');
    assert.equal(tools(derived!), resident, 'premise: the derivation shows the resident\'s tool block');
    assert.equal(tools(resumed!), resident, 'and so does the resumption');
  });

  it("with persist left out or 'look', keeps a fork's name, record, framing row and trace as they were", { timeout: 180_000 }, async () => {
    for (const persist of [undefined, 'look'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `reader-persist-look-${persist ?? 'unset'}-`));
      dirs.push(dir);
      const contexts: ReaderFramingContext[] = [];
      const t = await boot(dir, { ...(persist ? { persist } : {}), framing: (ctx: ReaderFramingContext) => { contexts.push(ctx); return defaultReaderFraming(ctx); } });
      const epochId = t.enter();
      t.look(epochId, [t.hold(epochId, 'HELD-1')]);
      t.look(epochId, [t.hold(epochId, 'HELD-2')]);
      const names = [1, 2].map((n) => `reader/scout/${epochId.slice(0, 8)}/${n}`);
      for (const name of names) await t.looked(name, 1);
      assert.deepEqual(t.forkTraces().map((f) => Object.keys(f).filter((k) => k !== 'timestamp').sort()),
        [['agentName', 'channelId', 'epochId', 'held', 'serverId', 'trigger', 'type'], ['agentName', 'channelId', 'epochId', 'held', 'serverId', 'trigger', 'type']],
        `${persist ?? 'unset'}: a fork per look, its trace without the persisted fields`);
      assert.deepEqual(t.forkTraces().map((f) => f.agentName).sort(), names);
      for (const name of names) {
        const record = t.framework.getAgentRecord(name)!;
        assert.deepEqual(Object.keys(record.metadata ?? {}).sort(), ['channelId', 'epochId', 'trigger']);
        const framing = (await t.framework.inspectAgentContext(name)).getAllMessages()
          .find((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'tune-out-reader-framing')!;
        assert.deepEqual(Object.keys(framing.metadata as object).filter((k) => k !== 'ownRowOf' && k !== 'audience').sort(),
          ['channelId', 'epochId', 'heldMessageIds', 'kind', 'system', 'trigger'], `${name}: no resident mark`);
      }
      assert.deepEqual(contexts.map((c) => Object.keys(c).sort()), [0, 1].map(() =>
        ['backlog', 'channelId', 'dispositions', 'epochId', 'fork', 'notice', 'resident', 'trigger', 'voice']), 'a framing context without the new fields');
      assert.equal(t.traces.some((e) => e.type === 'tune-out:reader-rederived'), false);
      await t.framework.stop();
      frameworks.splice(frameworks.indexOf(t.framework), 1);
    }
  });
});
