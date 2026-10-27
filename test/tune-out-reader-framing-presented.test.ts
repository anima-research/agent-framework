/**
 * A reader fork's framing hand-off is a presentation to the fork (#291,
 * AF-5): with the presentation index, the held rows a fork's framing hands
 * it enter its window when its run takes it on, and it holds them while it
 * lives (presentedToAnyone), so no coalescer withdraws a row a reader was
 * handed. Its view, the residents' it inherits, keeps them out of its
 * compile, where the framing shows them: its first request is the
 * resident's last one, then the resident's reply, then the framing. A fork
 * its run refuses before taking it on (the host quiesced) is let go of its
 * framing, so a row it was handed counts as held by no reader that never
 * ran (review 2, J-AF28).
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageId } from '@animalabs/context-manager';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { GateModule } from './helpers/dendrite.js';
import { WireMembrane, final } from './helpers/wire-membrane.js';
import { supported } from './helpers/reader-fork-rig.js';

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

type Internals = {
  tuneOutCoordinator: TuneOutCoordinator;
  channelRegistry: { listChannelsRaw(): unknown[] };
  presentation: {
    presentedToAnyone(id: MessageId): boolean;
    holders(id: MessageId): Array<{ agent: string; via: string }>;
    framedToAny(id: MessageId): boolean;
    framed: Map<string, Set<MessageId>>;
  };
  invokeReaderFork(invocation: {
    serverId: string; channelId: string; epochId: string; trigger: 'cadence' | 'wake' | 'cancel';
    notice: string; backlog: unknown[]; dispositions: string | null;
  }): void;
  removePlacement(p: { agent: string; messageId?: string }): boolean;
  addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): MessageId;
  pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("a reader fork's framing is a presentation to the fork (#291, AF-5)", { skip: supported ? false : 'needs ContextManager.derive' }, () => {
  it('presents the held rows it hands into the fork, which holds them while it runs, and keeps them out of its compile', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-framing-presented-'));
    dirs.push(dir);
    const commandPath = join(dir, 'commands.txt');
    writeFileSync(commandPath, '');
    const membrane = new WireMembrane();
    membrane.identify = (request) => (JSON.stringify(request.messages).includes('[Tune-out reader') ? 'reader' : 'scout');
    const gates = new GateModule();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
      subconscious: { enabled: true, reader: 'forks', model: 'test-model', voice: 'Read for scout.' },
      mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(dir, 'status.jsonl'), COMMAND_PATH: commandPath } }],
      modules: [gates],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    frameworks.push(framework);
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));
    const internals = framework as unknown as Internals;
    await framework.start();
    await waitFor('channel registration', () => internals.channelRegistry.listChannelsRaw().length > 0);
    const say = (kind: 'ambient' | 'addressed', id: string, t: string) => appendFileSync(commandPath, `${kind} ${id} ${t}\n`);
    const scoutRow = (t: string) => framework.getAgent('scout')!.getContextManager().getAllMessages().find((m) => textOf(m).includes(t));

    // A turn of the resident's before the tune-out: its request is the
    // prefix the fork inherits.
    membrane.script('scout', final([text('scout hears you')]));
    internals.addMessage('antra', [text('hello scout')], {}, { forAgent: 'scout' });
    internals.pendingRequests.push({ agentName: 'scout', reason: 'test', source: 'test', timestamp: Date.now() });
    await waitFor("the resident's turn", () => !!scoutRow('scout hears you'));
    await framework.runUntilIdle();
    const residentRequest = membrane.callsFor('scout').at(-1)!;

    assert.ok(internals.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool').ok);
    // While the fork runs: what holds the rows it was handed.
    let during: { fork: string; held: MessageId[]; inWindow: boolean[]; holders: string[][]; anyone: boolean[]; withdrawn: boolean } | undefined;
    membrane.onRequest = (agent) => {
      if (agent !== 'reader' || during) return;
      const fork = (traces.find((t) => t.type === 'tune-out:reader-fork') as { agentName: string } | undefined)?.agentName ?? '';
      const held = ['AMB-1', 'ADDR-2'].map((t) => scoutRow(t)!.id);
      const forkCm = framework.getAgent(fork)!.getContextManager();
      during = {
        fork,
        held,
        inWindow: held.map((id) => forkCm.ordinalOf(id) !== undefined),
        holders: held.map((id) => internals.presentation.holders(id).map((h) => `${h.agent}:${h.via}`)),
        anyone: held.map((id) => internals.presentation.presentedToAnyone(id)),
        withdrawn: internals.removePlacement({ agent: 'scout', messageId: held[0] }),
      };
    };
    membrane.script('reader', final([text('Nothing urgent.')]));
    say('ambient', 'a1', 'AMB-1 chatter');
    await waitFor('the first held message stored', () => !!scoutRow('AMB-1'));
    say('addressed', 'x2', 'ADDR-2 hey scout');
    await waitFor("the fork's request", () => during !== undefined);
    await framework.runUntilIdle();

    assert.ok(during!.fork.startsWith('reader/scout/'), during!.fork);
    assert.deepEqual(during!.inWindow, [true, true], "the handed rows are in the fork's window");
    assert.deepEqual(during!.holders, [[`${during!.fork}:framing`], [`${during!.fork}:framing`]], 'the fork holds them, as framed');
    assert.deepEqual(during!.anyone, [true, true], 'so they count as presented');
    assert.equal(during!.withdrawn, false, 'and a coalescer withdraw of one is refused');
    assert.ok(scoutRow('AMB-1'), 'which stays stored');

    // Its first request: the resident's last, the resident's reply, then the framing.
    const forkRequest = membrane.callsFor('reader')[0]!;
    const plain = (r: NormalizedRequest) => r.messages.map(({ participant, content }) => ({ participant, content }));
    assert.deepStrictEqual(plain(forkRequest).slice(0, residentRequest.messages.length), plain(residentRequest), "it starts with the resident's last request");
    const rest = forkRequest.messages.slice(residentRequest.messages.length).map((m) => textOf(m as never));
    const epochId = (traces.find((t) => t.type === 'tune-out:reader-fork') as { epochId: string }).epochId;
    assert.equal(rest[0], 'scout hears you', "then the resident's reply");
    assert.equal(rest.at(-1)!.split('\n')[0], `[Tune-out reader — ${CHANNEL}, epoch ${epochId.slice(0, 8)}, wake]`, 'and last the framing');
    const body = JSON.stringify(forkRequest.messages);
    assert.equal(body.split('AMB-1 chatter').length - 1, 1, 'the held message is in the framing alone, not raw beside it');

    // Once the fork ends it holds nothing.
    await waitFor('the fork ended', () => !framework.getAgent(during!.fork));
    assert.equal(internals.presentation.presentedToAnyone(during!.held[0]!), false, 'a framed row is held only while the fork lives');
  });

  // J-AF28: the framing was noted at the fork's derivation, and its run's
  // refusal (here, a quiesced host's) came before its registration, so no
  // end of the fork's let it go: the row stayed framed to a fork that never
  // ran for the life of the process, and no coalescer could take it out.
  it('lets go of the framing of a fork its run refused before taking it on', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-framing-refused-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'commands.txt'), '');
    const membrane = new WireMembrane();
    membrane.identify = (request) => (JSON.stringify(request.messages).includes('[Tune-out reader') ? 'reader' : 'scout');
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
      subconscious: { enabled: true, reader: 'forks', model: 'test-model', voice: 'Read for scout.' },
      mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(dir, 'status.jsonl'), COMMAND_PATH: join(dir, 'commands.txt') } }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    frameworks.push(framework);
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));
    const internals = framework as unknown as Internals;
    await framework.start();
    await waitFor('channel registration', () => internals.channelRegistry.listChannelsRaw().length > 0);

    const entered = internals.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool');
    assert.ok(entered.ok);
    const epochId = entered.params.epochId;
    const id = internals.addMessage('antra', [text('HELD-1 chatter')], { tuneOut: { epochId }, channelId: CHANNEL, serverId: 'disc' });
    const row = framework.getAgent('scout')!.getContextManager().getAllMessages().find((m) => m.id === id)!;
    await framework.quiesce({ reason: 'test' });
    // The invocation a cadence period or a cancel hands the framework.
    internals.invokeReaderFork({ serverId: 'disc', channelId: CHANNEL, epochId, trigger: 'cadence', notice: '[Tune-out cadence: test]', backlog: [row], dispositions: null });
    await waitFor("the fork's refusal", () => traces.some((t) => t.type === 'tune-out:reader-fork-failed'));
    const failed = traces.find((t) => t.type === 'tune-out:reader-fork-failed') as { agentName: string; error: string; returned: number };
    assert.match(failed.error, /quiesced/, 'premise: its run refused it before taking it on');
    assert.equal(framework.getAgent(failed.agentName) ?? undefined, undefined, 'premise: never registered');
    assert.ok(traces.some((t) => t.type === 'tune-out:reader-fork' && (t as { agentName?: string }).agentName === failed.agentName),
      'premise: framed at its derivation');
    assert.equal(failed.returned, 1, 'its row goes back to the next reader');
    await framework.resume();
    await framework.runUntilIdle();

    assert.equal(internals.presentation.framedToAny(id), false, 'no reader holds it as framing');
    assert.deepEqual(internals.presentation.holders(id), [], 'nor names a fork that never ran');
    assert.equal(internals.presentation.presentedToAnyone(id), false);
    assert.equal(internals.presentation.framed.has(failed.agentName), false, 'nothing is kept for the fork');
    assert.equal(internals.removePlacement({ agent: 'scout', messageId: id }), true, 'and a coalescer may take the unread row out');
  });
});
