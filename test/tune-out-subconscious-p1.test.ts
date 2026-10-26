/**
 * #793's P1 on the persistent subconscious (#291, AF-5): what a tune-out
 * holds while the resident's turn runs reaches the subconscious, and, with
 * the presentation index, what a resident's slot takes during the
 * subconscious's own turn stays out of that turn.
 *
 * P1 (nissa's probe, hilda-793-persistent): two ambient messages, then an
 * addressed one, arrive in a tuned-out channel (a) with the resident idle,
 * (b) while the resident's turn waits on a tool. The addressed one wakes the
 * subconscious. Its wake request must hold all three, stored by then, and
 * no request of the resident's any of them. Until AF-5 a held message was
 * deferred behind the resident's live turn, and the subconscious's view,
 * which reads stored rows, was missing exactly the traffic that came while
 * the resident was busy (P1b). A held message is stored at once now, with
 * the flag off and on. The number of requests per wake isn't pinned: the
 * probe saw several, in both arms, which nothing here explains or needs.
 *
 * P1' (the window, flag on): a row stored in the residents' slot during the
 * subconscious's own turn isn't in that turn's request. It enters at the
 * turn's tool boundary, where the stream is given it, at an ordinal past
 * the round's; the turn's signed thinking is sent again at its next
 * request, which begins with the one before it; and the resident's tool
 * rounds go out to it as a transcript, without the resident's thinking.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompileResult, MessageId, MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { GateModule } from './helpers/dendrite.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import { WireMembrane, final, round, signed } from './helpers/wire-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';
const SUB = 'Subconscious';
const usage = { inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 };

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (m: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

/** A round of the subconscious's own tool: `content`, then a call of `tool` with `input`. */
const subRound = (id: string, content: ContentBlock[], tool: string, input: object): NormalizedResponse =>
  Object.assign(createMockResponse([...content, { type: 'tool_use', id, name: tool, input } as ContentBlock], 'tool_use'), { usage });

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
  pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string }): MessageId;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A resident (scout) and the persistent subconscious on the tune-out fixture's channel, the requests recorded by agent. */
async function boot(options: { thinkingBinding?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tune-out-sub-p1-'));
  dirs.push(dir);
  const commandPath = join(dir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new WireMembrane();
  const gates = new GateModule();
  gates.broadcastOn = 'external-message';
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'scout', model: 'claude-opus-5-5', systemPrompt: 'You are scout.', allowedTools: 'all', proseRouting: 'disabled',
      ...(options.thinkingBinding ? { thinkingBinding: { binds: true } } : {}),
    }],
    subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for scout.' },
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
  const cm = (name: string) => framework.getAgent(name)!.getContextManager();
  const storedHas = (t: string) => cm('scout').getAllMessages().some((m) => textOf(m).includes(t));
  const say = (kind: 'ambient' | 'addressed', id: string, t: string) => appendFileSync(commandPath, `${kind} ${id} ${t}\n`);
  return { framework, membrane, gates, traces, internals, cm, storedHas, say };
}

describe("the persistent subconscious reads what a tune-out held while the resident's turn ran (P1, #793, #291)", () => {
  // Each case once ran twice, without the presentation index and with it;
  // since #291 (AF-6) every framework presents, so it runs once.
  {
    for (const mode of ['idle', 'mid-turn'] as const) {
      const tag = `P1${mode === 'idle' ? 'a' : 'b'}`;
      it(`${tag}: its wake request holds the three held messages, stored by then, the resident ${mode}`, { timeout: 120_000 }, async () => {
        const h = await boot();
        assert.ok(h.internals.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 1, maxWakes: 5 }, 'agent-tool').ok);
        const tags = [`${tag}-AMB-1`, `${tag}-AMB-2`, `${tag}-ADDR-3`];
        // Where each held message stood when the subconscious's first request was made.
        let atRequest: string[] | undefined;
        let residentBusy: boolean | undefined;
        h.membrane.onRequest = (agent, request) => {
          if (agent !== SUB || atRequest || !JSON.stringify(request.messages).includes('[Tune-out wake')) return;
          atRequest = tags.map((t) => (h.storedHas(t) ? 'stored' : 'not stored'));
          residentBusy = h.gates.entered.has('p1') && !h.storedHas('Scout done.');
        };
        if (mode === 'mid-turn') {
          h.membrane.script('scout', round('w1', [text('Waiting.')], 'wait', { gate: 'p1' }), final([text('Scout done.')]));
          h.framework.pushEvent({ type: 'external-message', source: 'probe', content: 'go' } as never);
          await waitFor("the resident's tool", () => h.gates.entered.has('p1'));
        }
        h.say('ambient', `${tag}a`, `${tag}-AMB-1 first chatter`);
        await waitFor('the first ambient stored', () => h.storedHas(`${tag}-AMB-1`));
        h.say('ambient', `${tag}b`, `${tag}-AMB-2 second chatter`);
        await waitFor('the second ambient stored', () => h.storedHas(`${tag}-AMB-2`));
        h.say('addressed', `${tag}c`, `${tag}-ADDR-3 hey scout`);
        await waitFor("the subconscious's request at the wake", () => atRequest !== undefined);
        assert.equal(residentBusy, mode === 'mid-turn', mode === 'mid-turn' ? "the resident's turn still waited on its tool" : 'the resident was idle');

        const wake = h.membrane.callsFor(SUB).find((c) => JSON.stringify(c.messages).includes('[Tune-out wake'))!;
        const body = JSON.stringify(wake.messages);
        for (const t of tags) assert.ok(body.includes(t), `its wake request holds ${t}`);
        assert.deepEqual(atRequest, ['stored', 'stored', 'stored'], 'all three were stored by then');
        for (const call of h.membrane.callsFor('scout')) {
          const seen = JSON.stringify(call.messages);
          for (const t of tags) assert.ok(!seen.includes(t), `no request of the resident's holds ${t}`);
        }
        h.gates.release('p1');
        await h.framework.runUntilIdle();
        for (const t of tags) {
          assert.equal(h.cm('scout').getAllMessages().filter((m) => textOf(m).includes(t)).length, 1, `${t} is stored once`);
        }
      });
    }
  }

  {
    it("a held message stored during the resident's turn leaves its rounds' thinking as it was", { timeout: 120_000 }, async () => {
      // Stored at once, the held row stands in the record between the
      // resident's turn's start and its round, which its view leaves out:
      // its next request still begins with the one before and carries the
      // turn's signed thinking.
      const h = await boot({ thinkingBinding: true });
      const scoutCm = h.cm('scout');
      const strips: unknown[] = [];
      const compile = scoutCm.compile.bind(scoutCm);
      scoutCm.compile = (async (...args: Parameters<typeof compile>) => {
        const result: CompileResult = await compile(...args);
        if ((args[2] as { dryRun?: boolean } | undefined)?.dryRun !== true) strips.push(result.thinkingStrip);
        return result;
      }) as typeof compile;
      h.membrane.script('scout', round('t1', [signed('sig-1'), text('looking')], 'wait', { gate: 't' }), final([signed('sig-2'), text('done')]));
      h.membrane.script('scout', final([signed('sig-3'), text('again')]));
      h.internals.addMessage('antra', [text('a word first')], {}, { forAgent: 'scout' });
      h.internals.pendingRequests.push({ agentName: 'scout', reason: 'test', source: 'test', timestamp: Date.now() });
      await waitFor("the resident's tool", () => h.gates.entered.has('t'));
      h.internals.addMessage('antra', [text('HELD-MID chatter')], { tuneOut: { epochId: 'e-held' }, channelId: CHANNEL } as MessageMetadata);
      assert.ok(h.storedHas('HELD-MID'), 'stored at once, while the tool waits');
      h.gates.release('t');
      await waitFor("the resident's turn", () => h.storedHas('done'));
      await h.framework.runUntilIdle();
      h.internals.addMessage('antra', [text('a word after')], {}, { forAgent: 'scout' });
      h.internals.pendingRequests.push({ agentName: 'scout', reason: 'test', source: 'test', timestamp: Date.now() });
      await waitFor("the resident's next turn", () => h.storedHas('again'));
      await h.framework.runUntilIdle();

      const record = scoutCm.getAllMessages().map((m) => textOf(m));
      assert.ok(record.indexOf('HELD-MID chatter') < record.indexOf('looking'), 'premise: the record has it inside the turn, ahead of its round');
      const [first, second] = h.membrane.callsFor('scout') as [NormalizedRequest, NormalizedRequest];
      const plain = (r: NormalizedRequest) => r.messages.map(({ participant, content }) => ({ participant, content }));
      assert.deepStrictEqual(plain(second).slice(0, first.messages.length), plain(first), 'its next request starts with the one before');
      const signatures = second.messages.flatMap((m) => m.content).filter((b) => b.type === 'thinking').map((b) => (b as { signature?: string }).signature);
      assert.deepEqual(signatures, ['sig-1', 'sig-2'], "its turn's thinking is sent again");
      assert.deepEqual(strips.filter((x) => x !== undefined), [], 'no committing compile took thinking out');
      assert.ok(h.membrane.callsFor('scout').every((c) => !JSON.stringify(c.messages).includes('HELD-MID')), 'and none of its requests carried the held message');
    });
  }

  it("P1': with the presentation index, a row the residents' slot takes during the subconscious's turn enters at its tool boundary, and its turn's thinking is sent again", { timeout: 120_000 }, async () => {
    const h = await boot({ thinkingBinding: true });
    const sub = h.framework.getAgent(SUB)!;
    const subCm = sub.getContextManager();
    assert.equal(subCm.windowMode(), 'presented', 'premise: its window is presented');

    // A tool round of the resident's, which the subconscious watches.
    h.membrane.script('scout', round('s1', [signed('sig-scout-1'), text('scout looks')], 'wait', { gate: 's' }), final([signed('sig-scout-2'), text('scout done')]));
    h.framework.pushEvent({ type: 'external-message', source: 'probe', content: 'go' } as never);
    await waitFor("the resident's tool", () => h.gates.entered.has('s'));
    h.gates.release('s');
    await waitFor("the resident's turn", () => h.storedHas('scout done'));
    await h.framework.runUntilIdle();

    // The subconscious's turn: a round of its own tool (think, which changes
    // nothing its requests carry ahead of their messages), then its reply.
    // A row for the resident is stored as its first request is made, while
    // its turn is alive.
    h.membrane.script(SUB,
      // No text beside the call: prose its turn can't route would be
      // answered at the boundary with a notice of its own.
      subRound('n1', [signed('sig-sub-1')], 'think', { content: 'quiet so far' }),
      final([signed('sig-sub-2'), text('sub done')]));
    h.membrane.script(SUB, final([signed('sig-sub-3'), text('sub again')]));
    let during: MessageId | undefined;
    let inWindowAtWrite: number | undefined;
    h.membrane.onRequest = (agent) => {
      if (agent !== SUB || during) return;
      during = h.internals.addMessage('antra', [text('P1X-DURING a word for scout')], { channelId: 'elsewhere' } as MessageMetadata, { forAgent: 'scout' });
      inWindowAtWrite = subCm.ordinalOf(during);
    };
    const strips: unknown[] = [];
    const compile = subCm.compile.bind(subCm);
    subCm.compile = (async (...args: Parameters<typeof compile>) => {
      const result: CompileResult = await compile(...args);
      if ((args[2] as { dryRun?: boolean } | undefined)?.dryRun !== true) strips.push(result.thinkingStrip);
      return result;
    }) as typeof compile;
    const ask = () => h.internals.pendingRequests.push({ agentName: SUB, reason: 'test', source: 'test', timestamp: Date.now() });
    ask();
    await waitFor("the subconscious's turn", () => subCm.getAllMessages().some((m) => textOf(m) === 'sub done'));
    await h.framework.runUntilIdle();
    ask();
    await waitFor("the subconscious's second turn", () => subCm.getAllMessages().some((m) => textOf(m) === 'sub again'));
    await h.framework.runUntilIdle();

    const streams = h.membrane.streams.filter((s) => s.agent === SUB);
    assert.ok(streams.length >= 2, 'it ran two streams');
    const [first, second] = streams as [typeof streams[0], typeof streams[0]];
    assert.ok(during, 'the row was stored during its turn');
    assert.equal(inWindowAtWrite, undefined, 'out of its window while its turn was alive');
    assert.ok(!JSON.stringify(first.request.messages).includes('P1X-DURING'), "its turn's request didn't carry it");
    const injected = first.stream.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []);
    assert.deepEqual(injected.map((m) => textOf(m as never)), ['P1X-DURING a word for scout'], 'its tool boundary handed it to the stream');
    const roundRow = subCm.getAllMessages().find((m) => m.content.some((b) => b.type === 'tool_use' && (b as { id: string }).id === 'n1'))!;
    assert.ok(subCm.ordinalOf(during!)! > subCm.ordinalOf(roundRow.id)!, "it entered the window after the turn's round");

    // The next request goes on from the first, and carries the turn's thinking.
    const plain = (r: NormalizedRequest) => r.messages.map(({ participant, content }) => ({ participant, content }));
    assert.deepStrictEqual(plain(second.request).slice(0, first.request.messages.length), plain(first.request), 'its second request starts with its first');
    const signatures = second.request.messages.flatMap((m) => m.content)
      .filter((b) => b.type === 'thinking').map((b) => (b as { signature?: string }).signature);
    assert.deepEqual(signatures, ['sig-sub-1', 'sig-sub-2'], "its own rounds' thinking is sent again");
    assert.deepEqual(strips.filter((s) => s !== undefined), [], 'no committing compile of its took thinking out');

    // The resident's round reaches it as a transcript, none of its thinking.
    for (const call of h.membrane.callsFor(SUB)) {
      const body = JSON.stringify(call.messages);
      assert.ok(!body.includes('sig-scout-'), "no request of the subconscious's carries the resident's thinking");
      assert.ok(!call.messages.some((m) => m.participant !== SUB && m.content.some((b) => b.type === 'tool_use')), "nor another's tool call as a block");
    }
    const firstBody = first.request.messages.map((m) => textOf(m as never)).join('\n');
    assert.ok(firstBody.includes('[test--wait called: {"gate":"s"}]'), firstBody);
    assert.match(firstBody, /\[test--wait returned: .*released/);
    assert.ok(firstBody.includes('scout looks') && firstBody.includes('scout done'), "with the resident's words");
    assert.deepEqual(h.traces.filter((e) => e.type === 'presentation:hand-off-mismatch'), [], 'the boundary handed its stream the rows its window took');
  });
});
