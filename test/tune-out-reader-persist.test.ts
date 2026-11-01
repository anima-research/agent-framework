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
import { AgentFramework } from '../src/index.js';
import type { FrameworkConfig, TraceEvent } from '../src/index.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { WireMembrane, final } from './helpers/wire-membrane.js';

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
  store: { listBranches(): Array<{ name: string }>; currentBranch(): { name: string } };
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
    assert.deepEqual(record.metadata, { epochId, channelId: CHANNEL, trigger: 'cadence', persist: 'epoch', resync: 'window' }, "this incarnation's metadata");

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
