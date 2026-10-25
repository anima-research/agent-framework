/**
 * #291's audience stamp: every row the framework stores names who it is
 * for (`metadata.audience`), and an agent's own rows name it as their owner
 * (`metadata.ownRowOf`), whichever path stored them: the framework's
 * addMessage, or a writer that stores into an agent's context directly.
 * "Own" goes by who stored the row, not by its participant. The stamp is
 * metadata only, so compiles are what they were.
 *
 * Also the registry's own-slot / observe split as the framework uses it: an
 * ended subconscious reopens on its own isolated slot (it read the shared
 * slot through an observe edge, and was reopened on that slot before).
 *
 * And the deferred queue an earlier version left: its entries carry no
 * stamp, and are stamped when the queue is restored, so whichever flush
 * stores them stores them stamped, and one a tune-out holds is for nobody.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, audienceOf } from '../src/index.js';
import type {
  AgentRegistry, EventResponse, HeldMail, Module, ModuleContext, ProcessEvent, ProcessState,
  ToolCall, ToolDefinition, ToolResult,
} from '../src/index.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';
import { createMockResponse } from './helpers/mock-membrane.js';

type Row = { id: string; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> };

const textOf = (row: { content: ContentBlock[] }) =>
  row.content.map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join('');
const kindOf = (row: Row) => row.metadata?.kind;
const hasBlock = (row: Row, type: string) => row.content.some((b) => b.type === type);

/** A tool that answers at once, beside GateModule's blocking one. */
class PingModule implements Module {
  readonly name = 'pings';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
  getTools(): ToolDefinition[] {
    return [{ name: 'ping', description: 'answers at once', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: true, data: { pong: true } };
  }
}

const ping = (id: string) => createMockResponse([{ type: 'tool_use', id, name: 'pings--ping', input: {} }], 'tool_use');

let seq = 0;
function pushEvent(text: string, targetAgents?: string[]) {
  const n = ++seq;
  return {
    type: 'mcpl:push-event', serverId: 'notes', featureSet: 'notes',
    eventId: `ev-${n}`, content: [{ type: 'text', text }], timestamp: new Date().toISOString(),
    inferenceId: `inf-ev-${n}`, triggerInference: true,
    ...(targetAgents ? { targetAgents } : {}),
  };
}

describe('the audience stamp (#291)', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let gates: GateModule;
  let frameworks: AgentFramework[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'audience-stamp-'));
    membrane = new RoutedMembrane();
    gates = new GateModule();
    frameworks = [];
  });
  afterEach(async () => {
    for (const framework of frameworks.reverse()) { try { await framework.stop(); } catch { /* already stopped */ } }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function boot(options: { subconscious?: boolean; residents?: string[] } = {}): Promise<AgentFramework> {
    const residents = options.residents ?? ['mira', 'oren'];
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: residents.map((name, i) => ({
        name,
        model: 'test-model',
        systemPrompt: `You are ${name}.`,
        // The primary keeps a clock and has its tool results guarded, so
        // both of those writers are in the slot too.
        ...(i === 0 ? { clock: { intervalMinutes: 10 }, toolResultGuard: true } : {}),
      })),
      modules: [gates, new PingModule()],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
      ...(options.subconscious ? { subconscious: { enabled: true, systemPrompt: 'You notice.' } } : {}),
    } as never);
    frameworks.push(framework);
    return framework;
  }

  const rowsOf = (framework: AgentFramework, agent: string): Row[] =>
    framework.getAgent(agent)!.getContextManager().getAllMessages() as unknown as Row[];
  const saidBy = (framework: AgentFramework, text: string) => rowsOf(framework, 'mira').some((r) => textOf(r) === text);
  const handlePush = (framework: AgentFramework, event: unknown) =>
    (framework as unknown as { handleMcplPushEvent(event: unknown): void }).handleMcplPushEvent(event);

  it('every row the framework writes into the residents\' slot names who it is for, and own rows by who stored them', async () => {
    const framework = await boot();
    framework.start();

    // An untargeted event reaches both residents; mira's turn runs a tool round.
    membrane.script('mira', ping('call-1'), say('mira done'));
    membrane.script('oren', say('oren here'));
    handlePush(framework, pushEvent('hello both'));
    await until(() => saidBy(framework, 'mira done') && saidBy(framework, 'oren here'), 'both turns');
    await framework.runUntilIdle();

    // An event targeted at oren, stored in the slot all the same.
    membrane.script('oren', say('oren again'));
    handlePush(framework, pushEvent('only for oren', ['oren']));
    await until(() => saidBy(framework, 'oren again'), 'oren\'s second turn');
    await framework.runUntilIdle();

    // Mail from oren to mira; a lifecycle notice to mira (a copy fork made
    // from her); a puppeted call in mira's name.
    framework.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'a note for mira' }], { wake: false });
    membrane.script('worker-1', say('worker done'));
    const worker = await framework.deriveAgent({
      name: 'worker-1', from: 'mira', mode: 'copy',
      framing: [{ participant: 'user', content: [{ type: 'text', text: '[WORKER-FRAMING] count them' }] }],
    });
    membrane.identify = (request) => (JSON.stringify(request.messages).includes('[WORKER-FRAMING]') ? 'worker-1' : request.assistantParticipant ?? '');
    await framework.runEphemeralToCompletion(worker.agent, worker.contextManager);
    await framework.puppetToolCall('mira', 'pings--ping', {});
    await framework.runUntilIdle();

    const slot = rowsOf(framework, 'mira');
    assert.deepEqual(rowsOf(framework, 'oren').map((r) => r.id), slot.map((r) => r.id), 'the residents share one slot');

    // Every row carries a stamp.
    const unstamped = slot.filter((row) => audienceOf(row.metadata) === undefined);
    assert.deepEqual(unstamped.map((r) => `${r.participant}: ${textOf(r)}`), [], 'no row goes unstamped');

    // Inbound: for whom admission delivered it.
    const both = slot.find((r) => textOf(r).includes('hello both'))!;
    assert.deepEqual(both.metadata?.audience, ['mira', 'oren'], 'an untargeted event is for every recipient');
    assert.equal(both.metadata?.ownRowOf, undefined);
    const forOren = slot.find((r) => textOf(r).includes('only for oren'))!;
    assert.deepEqual(forOren.metadata?.audience, ['oren'], 'a targeted one for its target, in whichever store it lands');

    // Each resident's rounds and results, the clock and the puppeted pair: their own rows.
    const ownOf = (row: Row) => row.metadata?.ownRowOf;
    for (const row of slot.filter((r) => r.participant === 'mira')) {
      assert.equal(ownOf(row), 'mira', `mira's round is her own: ${textOf(row)}`);
      assert.deepEqual(row.metadata?.audience, ['mira']);
    }
    for (const row of slot.filter((r) => r.participant === 'oren' && kindOf(r) !== 'agent-message')) {
      assert.equal(ownOf(row), 'oren', `oren's round is his own: ${textOf(row)}`);
    }
    const results = slot.filter((r) => hasBlock(r, 'tool_result'));
    assert.equal(results.length, 2, 'the round\'s results and the puppeted call\'s');
    for (const row of results) assert.equal(ownOf(row), 'mira', 'tool results are the agent\'s own, guarded or not');
    const clocks = slot.filter((r) => kindOf(r) === 'clock');
    assert.ok(clocks.length > 0, 'mira keeps a clock');
    for (const row of clocks) assert.equal(ownOf(row), 'mira');

    // Mail and lifecycle notices: for their recipient, nobody's own row.
    const mail = slot.find((r) => kindOf(r) === 'agent-message')!;
    assert.equal(mail.participant, 'oren', 'in the sender\'s name');
    assert.deepEqual(mail.metadata?.audience, ['mira']);
    assert.equal(ownOf(mail), undefined, 'the sender\'s words, not the recipient\'s own row');
    assert.equal((mail.metadata?.dendrite as { to?: unknown }).to, 'mira', 'mail names its recipient');
    const notices = slot.filter((r) => kindOf(r) === 'agent-lifecycle');
    assert.ok(notices.length > 0, 'mira is told of the agent made from her');
    for (const row of notices) {
      assert.deepEqual(row.metadata?.audience, ['mira']);
      assert.equal(ownOf(row), undefined);
      assert.equal((row.metadata?.dendrite as { to?: unknown }).to, 'mira');
    }

    // The copy fork's store: its inheritance, framing and answer are its own rows.
    const workerRows = worker.contextManager.getAllMessages() as unknown as Row[];
    assert.ok(workerRows.some((r) => textOf(r).includes('[WORKER-FRAMING]')));
    for (const row of workerRows) {
      assert.equal(ownOf(row), 'worker-1', `the fork's own: ${row.participant}: ${textOf(row)}`);
    }
  });

  it('compiles are byte for byte what they were: the stamp is metadata only', async () => {
    const framework = await boot();
    framework.start();
    membrane.script('mira', ping('call-1'), say('mira done'));
    membrane.script('oren', say('oren here'));
    handlePush(framework, pushEvent('hello both'));
    await until(() => saidBy(framework, 'mira done') && saidBy(framework, 'oren here'), 'both turns');
    await framework.runUntilIdle();
    framework.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'a note for mira' }], { wake: false });
    await framework.runUntilIdle();

    const stamped = framework.getAgent('mira')!.getContextManager();
    const rows = stamped.getAllMessages();
    assert.ok(rows.length >= 6 && rows.every((r) => audienceOf(r.metadata) !== undefined), 'every row is stamped');

    // The same rows without the stamp, in a store of their own.
    const store = JsStore.openOrCreate({ path: join(tempDir, 'unstamped.chronicle') });
    try {
      const bare = await ContextManager.open({ store, namespace: 'agents/mira', strategy: new PassthroughStrategy() });
      for (const row of rows) {
        const { audience: _a, ownRowOf: _o, ...metadata } = (row.metadata ?? {}) as Record<string, unknown>;
        bare.addMessage(row.participant, row.content as ContentBlock[], metadata);
      }
      const shape = (messages: Array<{ participant: string; content: unknown }>) =>
        messages.map((m) => ({ participant: m.participant, content: m.content }));
      const before = (await bare.compile(undefined, undefined, { dryRun: true })).messages;
      const after = (await stamped.compile(undefined, undefined, { dryRun: true })).messages;
      assert.equal(after.length, rows.length);
      assert.deepEqual(shape(after), shape(before));
    } finally {
      store.close();
    }
  });

  it('a shared fork\'s mail from its parent is for the fork, not its own row, though it presents the parent\'s name as its own', async () => {
    const framework = await boot({ residents: ['mira'] });
    framework.start();
    membrane.identify = (request) => (JSON.stringify(request.messages).includes('[FORK-FRAMING]') ? 'fork-1' : request.assistantParticipant ?? '');
    membrane.script('fork-1', waitCall('g-fork'), say('fork done'));
    const fork = await framework.deriveAgent({
      name: 'fork-1', from: 'mira',
      framing: [{ participant: 'user', content: [{ type: 'text', text: '[FORK-FRAMING] look' }] }],
    });
    const run = framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
    await until(() => gates.entered.has('g-fork'), 'the fork to block in its tool');
    assert.equal(framework.getAgentRecord('fork-1')!.inherit?.mode, 'shared');
    assert.equal(fork.agent.isOwnParticipant('mira'), true, 'its parent\'s name is its own voice');

    framework.sendAgentMessage('mira', 'fork-1', [{ type: 'text', text: 'from your parent' }], { wake: false });
    gates.release('g-fork');
    await run;

    const rows = fork.contextManager.getAllMessages() as unknown as Row[];
    const mail = rows.find((r) => textOf(r).includes('from your parent'))!;
    assert.ok(mail, 'the mail reached the fork');
    assert.equal(mail.participant, 'mira', 'stored in its sender\'s name');
    assert.deepEqual(mail.metadata?.audience, ['fork-1'], 'for the fork');
    assert.equal(mail.metadata?.ownRowOf, undefined, 'and not the fork\'s own row: own goes by who stored it, not by name');
    assert.equal((mail.metadata?.dendrite as { to?: unknown }).to, 'fork-1');
    const framing = rows.find((r) => textOf(r).includes('[FORK-FRAMING]'))!;
    assert.equal(framing.metadata?.ownRowOf, 'fork-1', 'its framing is its own');
    const answer = rows.find((r) => r.participant === 'fork-1' && textOf(r) === 'fork done')!;
    assert.equal(answer.metadata?.ownRowOf, 'fork-1');
  });

  it('redelivers held mail unless a copy for its own recipient is stored: a copy for another resident doesn\'t count', async () => {
    const framework = await boot();
    const internals = framework as unknown as {
      registry: AgentRegistry;
      reconcileAgentRegistry(interrupted: unknown[]): void;
    };
    const cm = framework.getAgent('mira')!.getContextManager();
    const hold = (text: string): HeldMail => internals.registry.holdMail({
      kind: 'message', from: internals.registry.ref('mira'), to: 'oren', content: [{ type: 'text', text }],
    });
    // Mail for oren whose id a row for mira carries (it was hers before a
    // re-addressing, say); and mail for oren whose copy was stored before
    // mail named its recipient.
    const elsewhere = hold('for oren, stored for mira');
    cm.addMessage('mira', [{ type: 'text', text: 'for oren, stored for mira' }], { kind: 'agent-message', dendrite: { mailId: elsewhere.id, to: 'mira' } });
    const legacy = hold('for oren, stored before `to`');
    cm.addMessage('mira', [{ type: 'text', text: 'for oren, stored before `to`' }], { kind: 'agent-message', dendrite: { mailId: legacy.id } });

    internals.reconcileAgentRegistry([]);
    await framework.runUntilIdle();

    const copies = (id: string) => cm.getAllMessages().filter((m) => (m.metadata as { dendrite?: { mailId?: string } } | undefined)?.dendrite?.mailId === id);
    assert.deepEqual(copies(elsewhere.id).map((m) => (m.metadata as { dendrite: { to?: string } }).dendrite.to), ['mira', 'oren'],
      'delivered to oren: the stored copy was mira\'s');
    assert.equal(copies(legacy.id).length, 1, 'a copy with no recipient on it counts, as before');
    assert.deepEqual(framework.listHeldMail(), [], 'both released');
  });

  it('an ended subconscious reopens on its own isolated slot, with the residents\' slot it observed merged in', async () => {
    const first = await boot({ subconscious: true, residents: ['mira'] });
    const record = first.getAgentRecord('Subconscious')!;
    assert.deepEqual(record.ownSlot, { namespace: 'subconscious/mira' }, 'its own rows go to a slot of its own');
    assert.deepEqual(record.relationships.observes, [{ includeHeld: true }], 'it reads the residents\' slot as an observer');
    first.getAgent('Subconscious')!.getContextManager().addMessage('Subconscious', [{ type: 'text', text: 'my own note' }]);
    first.getAgent('mira')!.getContextManager().addMessage('user', [{ type: 'text', text: 'in the shared slot' }]);
    assert.equal(first.getAgent('mira')!.getContextManager().getAllMessages().some((m) => textOf(m).includes('my own note')), false,
      'the note is in the subconscious\'s slot alone');
    await first.stop();

    // Booted without it, it ends as not configured; inspection reopens what it left.
    const second = await boot({ residents: ['mira'] });
    assert.equal(second.getAgentRecord('Subconscious')?.ended?.reason, 'not-configured');
    const reopened = await second.inspectAgentContext('Subconscious');
    assert.deepEqual(reopened.getAllMessages().map(textOf), ['my own note'], 'its own slot, which a reopen on the shared slot never showed');
    const shown = (await reopened.compile(undefined, undefined, { dryRun: true })).messages.map(textOf);
    assert.ok(shown.includes('my own note') && shown.includes('in the shared slot'), 'and its view merges the slot it observed, as it read it');
    reopened.addMessage('user', [{ type: 'text', text: 'written on the reopened context' }]);
    assert.equal(second.getAgent('mira')!.getContextManager().getAllMessages().some((m) => textOf(m).includes('written on the reopened')), false,
      'and a write there goes to its own slot, not the residents\'');
  });

  // The deferred queue an earlier version persisted, before the stamp: each
  // entry as that version wrote it, with no audience on any (the reviewers'
  // probes, review-scratch/af1-review/probe.mjs and probe2.mjs).
  type QueuedEntry = { id: string; seq: number; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown>; forAgent?: string; heldAt: number };
  const olderPlain: QueuedEntry = { id: 'old-plain', seq: 1, participant: 'user', content: [{ type: 'text', text: 'OLD-PLAIN' }], heldAt: 1 };
  const olderHeld: QueuedEntry = {
    id: 'old-held', seq: 2, participant: 'user', content: [{ type: 'text', text: 'OLD-HELD' }],
    metadata: { tuneOut: { epochId: 'e1' }, channelId: 'c' }, heldAt: 2,
  };
  const olderForOren: QueuedEntry = {
    id: 'old-for-oren', seq: 3, participant: 'user', content: [{ type: 'text', text: 'OLD-FOR-OREN' }], forAgent: 'oren', heldAt: 3,
  };

  /** A host that an earlier version stopped (quiesced, or serving) with `entries` in its queue, booted again. */
  async function bootOnOlderQueue(entries: QueuedEntry[], options: { quiesced: boolean }): Promise<AgentFramework> {
    const first = await boot();
    if (options.quiesced) await first.quiesce({ reason: 'upgrade' });
    await first.stop();
    const recovery = join(tempDir, 'store.chronicle', 'recovery');
    mkdirSync(recovery, { recursive: true });
    writeFileSync(join(recovery, 'deferred-writes.json'), JSON.stringify({ version: 2, pending: entries }));
    return boot();
  }

  const rowNamed = (framework: AgentFramework, text: string): Row | undefined =>
    rowsOf(framework, 'mira').find((r) => textOf(r) === text);

  it('an entry an earlier version left queued is stamped when the queue is restored, so a flush that stores it straight into the store stores it stamped', async () => {
    const framework = await bootOnOlderQueue([olderPlain, olderHeld, olderForOren], { quiesced: true });
    const internals = framework as unknown as {
      deferredMessages: Array<{ id: string; metadata?: Record<string, unknown> }>;
      flushForStart(agent: unknown, occasion: 'turn-start' | 'assembly'): boolean;
    };
    // Restored with the stamp this version queues a write with: for the
    // agent it is queued for (the primary when it names none), and for
    // nobody when a tune-out holds it. Nobody's own row.
    assert.deepEqual(
      Object.fromEntries(internals.deferredMessages.map((m) => [m.id, audienceOf(m.metadata)])),
      { 'old-plain': { audience: ['mira'] }, 'old-held': { audience: [] }, 'old-for-oren': { audience: ['oren'] } },
    );

    // A turn start's flush stores what is queued for its agent straight into
    // its store, with the metadata the entry was queued with (the reviewers'
    // probe.mjs stored it there unstamped). A quiesced host starts no turn,
    // so the flush is called here as a turn start calls it; on a live host it
    // meets a restored entry that resume()'s flush couldn't store.
    internals.flushForStart(framework.getAgent('mira')!, 'turn-start');
    const plain = rowNamed(framework, 'OLD-PLAIN');
    assert.deepEqual(plain?.metadata?.audience, ['mira'], 'for the primary');
    assert.equal(plain?.metadata?.ownRowOf, undefined);
    assert.equal(plain?.metadata?.deferredWriteId, 'old-plain');
    const held = rowNamed(framework, 'OLD-HELD');
    assert.deepEqual(held?.metadata?.audience, [], 'for nobody: a tune-out holds it');
    assert.deepEqual(held?.metadata?.tuneOut, { epochId: 'e1' }, 'its hold kept');
    assert.equal(rowNamed(framework, 'OLD-FOR-OREN'), undefined, 'oren\'s entry waits for oren');

    // resume()'s flush stores the rest through addMessage, carrying the stamp.
    await framework.resume();
    const forOren = rowNamed(framework, 'OLD-FOR-OREN');
    assert.deepEqual(forOren?.metadata?.audience, ['oren'], 'for the agent it was queued for');
    assert.equal(forOren?.metadata?.deferredWriteId, 'old-for-oren');
    const unstamped = rowsOf(framework, 'mira').filter((row) => audienceOf(row.metadata) === undefined);
    assert.deepEqual(unstamped.map((r) => `${r.participant}: ${textOf(r)}`), [], 'no row goes unstamped');
  });

  it('stop()\'s drain stores a held entry an earlier version left queued for nobody, its hold kept', async () => {
    // A serving boot lands the restored queue at once (boot recovery). Its
    // write of the held entry fails here, once, before anything is stored,
    // so the entry stays queued for mira until stop()'s drain stores it.
    const proto = ContextManager.prototype as unknown as { addMessage(...args: unknown[]): unknown };
    const real = proto.addMessage;
    let failed = false;
    proto.addMessage = function (this: unknown, ...args: unknown[]) {
      if (!failed && textOf({ content: args[1] as ContentBlock[] }) === 'OLD-HELD') {
        failed = true;
        throw new Error('store unavailable');
      }
      return real.apply(this, args);
    };
    let framework: AgentFramework;
    try {
      framework = await bootOnOlderQueue([olderPlain, olderHeld], { quiesced: false });
    } finally {
      proto.addMessage = real;
    }
    assert.ok(failed, 'the boot recovery tried the held entry');
    assert.deepEqual(rowNamed(framework, 'OLD-PLAIN')?.metadata?.audience, ['mira'], 'the boot recovery stored the plain one, for the primary');
    assert.equal(rowNamed(framework, 'OLD-HELD'), undefined);
    assert.equal(framework.getHostModeStatus().deferredWrites, 1, 'the held one still queued');

    await framework.stop();
    const after = await boot();
    const held = rowNamed(after, 'OLD-HELD');
    assert.ok(held, 'stop()\'s drain stored it');
    assert.deepEqual(held.metadata?.audience, [], 'for nobody, not for the agent whose store it landed in (it was [\'mira\'])');
    assert.equal(held.metadata?.ownRowOf, undefined);
    assert.deepEqual(held.metadata?.tuneOut, { epochId: 'e1' }, 'its hold kept');
    assert.equal(held.metadata?.deferredWriteId, 'old-held');
  });

  it('a write that carries a tune-out\'s hold and no stamp, handed back from the queue as stop()\'s drain hands it, is for nobody', async () => {
    // The reviewers' probe2.mjs: addMessage stamped a write from the queue
    // that carried no stamp for its delivery agent, held or not. Restore now
    // stamps what an earlier version queued; this is addMessage's own rule,
    // for any write with the hold that doesn't say who it is for.
    const framework = await boot({ residents: ['mira'] });
    const entry: QueuedEntry = {
      id: 'unstamped-held', seq: 1, participant: 'user', content: [{ type: 'text', text: 'UNSTAMPED-HELD' }],
      metadata: { tuneOut: { epochId: 'e1' }, channelId: 'c' }, heldAt: Date.now(),
    };
    const internals = framework as unknown as {
      readdDrained(drained: QueuedEntry[], where: string, opts?: { bypassDeferral?: boolean }): QueuedEntry[];
    };
    assert.equal(internals.readdDrained([entry], 'stop', { bypassDeferral: true }).length, 1);
    const row = rowNamed(framework, 'UNSTAMPED-HELD');
    assert.deepEqual(row?.metadata?.audience, [], 'for nobody, not [\'mira\']');
    assert.deepEqual(row?.metadata?.tuneOut, { epochId: 'e1' }, 'its hold kept');
  });
});
