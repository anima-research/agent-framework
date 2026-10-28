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
 * slot through an observe edge, and was reopened on that slot before), and a
 * row in that slot is unread until the subconscious, its one reader, has
 * compiled past it, whatever the residents have read.
 *
 * And the deferred queue an earlier version left: its entries carry no
 * stamp, and are stamped when the queue is restored, so whichever flush
 * stores them stores them stamped, and one a tune-out holds is for nobody.
 *
 * And a write that names no agent: it is for every agent that takes
 * untargeted inbound in the slot it lands in, so the record tells it from a
 * write for the primary; a process response's messages are for the agents
 * its inference request names. With one resident, nothing changes.
 *
 * And held mail's copies: a copy for another recipient than the mail's
 * (`dendrite.to`) is not its delivery, whether stored, queued or landing.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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

/**
 * A surface's module, as an API, TUI or workspace module answers its input:
 * an `external-message` event's content becomes a message, with the
 * inference request its metadata names (`ask`). It keeps its context, for a
 * write of its own.
 */
class SurfaceModule implements Module {
  readonly name = 'surface';
  ctx!: ModuleContext;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const { content, metadata } = event as unknown as { content: ContentBlock[]; metadata: { ask?: boolean | string[] } };
    return { addMessages: [{ participant: 'user', content }], ...(metadata.ask !== undefined ? { requestInference: metadata.ask } : {}) };
  }
}

/** Input through the surface, asking `ask` to read it. */
const surfaceInput = (text: string, ask?: boolean | string[]): ProcessEvent => ({
  type: 'external-message', source: 'test', content: [{ type: 'text', text }],
  metadata: ask === undefined ? {} : { ask },
});

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
  let surface: SurfaceModule;
  let frameworks: AgentFramework[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'audience-stamp-'));
    membrane = new RoutedMembrane();
    gates = new GateModule();
    surface = new SurfaceModule();
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
      modules: [gates, new PingModule(), surface],
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

  /** Input through the surface, each asking whom it names to read it, each answered before the next. */
  async function surfaceInputs(framework: AgentFramework, inputs: Array<[text: string, ask?: boolean | string[]]>): Promise<void> {
    for (const [text, ask] of inputs) {
      framework.pushEvent(surfaceInput(text, ask));
      await framework.runUntilIdle();
    }
  }

  /** mira's compile against the same rows unstamped, in a store of their own: the stamp is metadata only. */
  async function assertCompilesAsUnstamped(framework: AgentFramework): Promise<void> {
    const stamped = framework.getAgent('mira')!.getContextManager();
    assert.ok(stamped.getAllMessages().every((r) => audienceOf(r.metadata) !== undefined), 'every row is stamped');
    // Her window (#291): the rows she was shown, which another resident's own
    // rows aren't among, unstamped, compile as they do stamped.
    const rows = stamped.getPresentedMessages();
    assert.ok(rows.length >= 6, 'her window holds the rows');
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
  }

  it('compiles are byte for byte what they were: the stamp is metadata only', async () => {
    const framework = await boot();
    framework.start();
    membrane.script('mira', ping('call-1'), say('mira done'));
    membrane.script('oren', say('oren here'));
    handlePush(framework, pushEvent('hello both'));
    await until(() => saidBy(framework, 'mira done') && saidBy(framework, 'oren here'), 'both turns');
    await framework.runUntilIdle();
    framework.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'a note for mira' }], { wake: false });
    // Writes that name no agent, and a response's for the agent it asks to read.
    surface.ctx.addMessage('user', [{ type: 'text', text: 'MODULE-WRITE' }]);
    await surfaceInputs(framework, [['UNTARGETED'], ['ASKS-OREN', ['oren']]]);
    await framework.runUntilIdle();
    await assertCompilesAsUnstamped(framework);
  });

  it('with one resident, a write that names no agent is stamped for it, as before, and compiles are what they were', async () => {
    // A single-resident host: the stamp of every write that names no agent
    // is the resident, the stamp the delivery agent gave it before such a
    // write was told from one for the primary, whatever the response asks.
    const framework = await boot({ residents: ['mira'] });
    framework.start();
    membrane.script('mira', ping('call-1'), say('mira done'));
    handlePush(framework, pushEvent('hello'));
    await until(() => saidBy(framework, 'mira done'), 'mira\'s turn');
    await framework.runUntilIdle();
    surface.ctx.addMessage('user', [{ type: 'text', text: 'MODULE-WRITE' }]);
    await surfaceInputs(framework, [['UNTARGETED'], ['ASKS-EVERYONE', true], ['ASKS-MIRA', ['mira']], ['ASKS-A-STRANGER', ['ghost']]]);
    for (const text of ['MODULE-WRITE', 'UNTARGETED', 'ASKS-EVERYONE', 'ASKS-MIRA', 'ASKS-A-STRANGER']) {
      assert.ok(saidBy(framework, text), `${text} is stored`);
    }
    const slot = rowsOf(framework, 'mira');
    assert.deepEqual(slot.filter((r) => !isDeepStrictEqual(r.metadata?.audience, ['mira'])).map((r) => `${r.participant}: ${textOf(r)}`), [],
      'every row is for mira, as before');
    await assertCompilesAsUnstamped(framework);
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
    // The house's rule (6b7d2c28): mail from a sender the recipient counts as
    // its own voice is stored as `<sender> (mail)`, so no request presents it
    // as the fork's own turn; on this branch it is also for the fork and not
    // its own row, as below.
    assert.equal(mail.participant, 'mira (mail)', 'stored in its sender\'s name, marked as mail');
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

  /** Held mail for oren, and a copy of it queued for mira (it was hers before a re-addressing, say). */
  /** Held mail for oren, and a copy of it for mira stored in the residents' slot. */
  function mailForOrenWithACopyForMira(framework: AgentFramework, text: string): HeldMail {
    const internals = framework as unknown as {
      registry: AgentRegistry;
      addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): string;
    };
    const mail = internals.registry.holdMail({
      kind: 'message', from: internals.registry.ref('mira'), to: 'oren', content: [{ type: 'text', text }],
    });
    internals.addMessage('mira', [{ type: 'text', text }], { kind: 'agent-message', dendrite: { mailId: mail.id, to: 'mira' } }, { forAgent: 'mira' });
    return mail;
  }
  /** The recipient (`dendrite.to`) of each copy of a mail in the residents' slot, in store order. */
  const copiesOf = (framework: AgentFramework, mail: HeldMail) => rowsOf(framework, 'mira')
    .filter((r) => (r.metadata?.dendrite as { mailId?: string } | undefined)?.mailId === mail.id)
    .map((r) => (r.metadata?.dendrite as { to?: string }).to);

  it('a copy of held mail for another resident that lands doesn\'t release the mail: its own delivery does', async () => {
    const framework = await boot();
    const internals = framework as unknown as { reconcileAgentRegistry(interrupted: unknown[]): void };
    const mail = mailForOrenWithACopyForMira(framework, 'for oren, a copy for mira that lands');

    assert.deepEqual(copiesOf(framework, mail), ['mira'], 'mira\'s copy landed');
    assert.deepEqual(framework.listHeldMail().map((m) => m.id), [mail.id], 'still held for oren: the copy wasn\'t his');

    internals.reconcileAgentRegistry([]);
    await framework.runUntilIdle();
    assert.deepEqual(copiesOf(framework, mail), ['mira', 'oren'], 'boot\'s check delivers it to oren');
    assert.deepEqual(framework.listHeldMail(), [], 'which releases it');
  });

  it('an ended subconscious reopens on its own isolated slot, with the residents\' slot it observed merged in', async () => {
    const first = await boot({ subconscious: true, residents: ['mira'] });
    const record = first.getAgentRecord('Subconscious')!;
    assert.deepEqual(record.ownSlot, { namespace: 'subconscious/mira' }, 'its own rows go to a slot of its own');
    assert.deepEqual(record.relationships.observes, [{ includeHeld: true }], 'it reads the residents\' slot as an observer');
    first.getAgent('Subconscious')!.getContextManager().addMessage('Subconscious', [{ type: 'text', text: 'my own note' }]);
    first.getAgent('mira')!.getContextManager().addMessage('user', [{ type: 'text', text: 'in the shared slot' }]);
    // Written past the framework, both enter the subconscious's window at its next point (#291).
    (first as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(first.getAgent('Subconscious'));
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

  it('a write for the subconscious, in its own slot, is unread until the subconscious compiles past it, whatever the residents have read', async () => {
    // The coalescer retracts or replaces only an unread message (its isUnread,
    // then removePlacement). A row's readers are the agents whose own slot it
    // is in and those that observe that slot (registry.readersOf): for the
    // subconscious's own slot, the subconscious alone. While the subconscious
    // read as a reader of the residents' slot, the residents' watermarks
    // counted for its own rows too, so such a row counted as read once a
    // resident compiled, though the subconscious never had.
    const framework = await boot({ subconscious: true });
    type Placement = { agent?: string; messageId?: string };
    const internals = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata: unknown, opts: { forAgent: string; placement: Placement }): string;
      isUnreadPlacement(placement: Placement, by?: 'consumed' | 'shown'): boolean;
      removePlacement(placement: Placement): boolean;
    };
    const subconscious = framework.getAgent('Subconscious')!;
    // Written through the framework's addMessage for the subconscious by
    // name, as a module's hook (the tune-out coordinator's, the gate's)
    // writes for an agent it names.
    const write = (text: string): Placement => {
      const placement: Placement = {};
      internals.addMessage('user', [{ type: 'text', text }], { kind: 'test-note' }, { forAgent: 'Subconscious', placement });
      return placement;
    };
    const notes = (agent: string) => rowsOf(framework, agent).map(textOf).filter((t) => t.endsWith('for the subconscious'));

    subconscious.markContextConsumed(); // it has compiled, before either write
    const first = write('first for the subconscious');
    const second = write('second for the subconscious');
    assert.deepEqual([first.agent, second.agent], ['Subconscious', 'Subconscious']);
    assert.deepEqual(notes('Subconscious'), ['first for the subconscious', 'second for the subconscious']);
    assert.deepEqual(notes('mira'), [], 'in its own slot, not the residents\'');

    // Both residents compile past both rows' places in the store.
    for (const name of ['mira', 'oren']) framework.getAgent(name)!.markContextConsumed();
    assert.equal(internals.isUnreadPlacement({ ...first }), true, 'unread: the residents read another slot');
    assert.equal(internals.isUnreadPlacement({ ...first }, 'shown'), true, 'and never shown');
    assert.equal(internals.removePlacement({ ...first }), true, 'so it can be retracted');
    assert.deepEqual(notes('Subconscious'), ['second for the subconscious'], 'and is');

    // The subconscious compiles past the other: read.
    subconscious.markContextConsumed();
    assert.equal(internals.isUnreadPlacement({ ...second }), false, 'read once the subconscious compiled past it');
    assert.equal(internals.isUnreadPlacement({ ...second }, 'shown'), false, 'and shown');
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

  it("an entry an earlier version left queued is stamped as the boot's import stores it", async () => {
    // #291's one-release importer stores each entry through addMessage, with
    // the stamp addMessage gives any write: for the agent it is queued for;
    // for every resident when it names none, as a write that names no agent
    // is; and for nobody when a tune-out holds it. Nobody's own row.
    const framework = await bootOnOlderQueue([olderPlain, olderHeld, olderForOren], { quiesced: true });
    const plain = rowNamed(framework, 'OLD-PLAIN');
    assert.deepEqual(plain?.metadata?.audience, ['mira', 'oren'], 'for every resident: it names no agent');
    assert.equal(plain?.metadata?.ownRowOf, undefined);
    assert.equal(plain?.metadata?.deferredWriteId, 'old-plain');
    const held = rowNamed(framework, 'OLD-HELD');
    assert.deepEqual(held?.metadata?.audience, [], 'for nobody: a tune-out holds it');
    assert.deepEqual(held?.metadata?.tuneOut, { epochId: 'e1' }, 'its hold kept');
    const forOren = rowNamed(framework, 'OLD-FOR-OREN');
    assert.deepEqual(forOren?.metadata?.audience, ['oren'], 'for the agent it was queued for');
    assert.equal(forOren?.metadata?.deferredWriteId, 'old-for-oren');
    const unstamped = rowsOf(framework, 'mira').filter((row) => audienceOf(row.metadata) === undefined);
    assert.deepEqual(unstamped.map((r) => `${r.participant}: ${textOf(r)}`), [], 'no row goes unstamped');
  });

  it("a write that carries a tune-out's hold and no stamp is for nobody", async () => {
    // The reviewers' probe2.mjs: addMessage stamped a write that carried no
    // stamp for its delivery agent, held or not. This is addMessage's own
    // rule, for any write with the hold that doesn't say who it is for.
    const framework = await boot({ residents: ['mira'] });
    const internals = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>): string;
    };
    assert.ok(internals.addMessage('user', [{ type: 'text', text: 'UNSTAMPED-HELD' }], { tuneOut: { epochId: 'e1' }, channelId: 'c' }));
    const row = rowNamed(framework, 'UNSTAMPED-HELD');
    assert.deepEqual(row?.metadata?.audience, [], 'for nobody, not [\'mira\']');
    assert.deepEqual(row?.metadata?.tuneOut, { epochId: 'e1' }, 'its hold kept');
  });

  // A write that names no agent lands in the primary's store, which on a
  // residents' host is the slot every resident reads, and was stamped for the
  // primary alone, as a write for the primary is: the record couldn't tell
  // them apart, and a process response's messages were stamped for the
  // primary even when its inference request asked another agent to read
  // them (the reviewers' af1-review probe.mjs (b)).
  it('a write that names no agent is for every resident, and a process response\'s messages for the agents its inference request names', async () => {
    const framework = await boot();
    framework.start();
    const addMessage = (framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): string;
    }).addMessage.bind(framework);

    surface.ctx.addMessage('user', [{ type: 'text', text: 'MODULE-WRITE' }]);
    addMessage('user', [{ type: 'text', text: 'NAMES-NO-AGENT' }]);
    addMessage('user', [{ type: 'text', text: 'FOR-MIRA' }], undefined, { forAgent: 'mira' });
    await surfaceInputs(framework, [
      ['UNTARGETED'],
      ['ASKS-OREN', ['oren']],
      ['ASKS-EVERYONE', true],
      ['ASKS-OREN-TWICE-AND-A-STRANGER', ['oren', 'ghost', 'oren']],
      ['ASKS-A-STRANGER', ['ghost']],
      ['ASKS-NOBODY', []],
    ]);
    const audience = (text: string) => {
      const row = rowNamed(framework, text);
      assert.ok(row, `${text} is stored`);
      assert.equal(row.metadata?.ownRowOf, undefined, `${text} is nobody's own row`);
      return row.metadata?.audience;
    };

    // Named no agent: every resident that takes untargeted inbound in the slot, not the primary alone.
    assert.deepEqual(audience('MODULE-WRITE'), ['mira', 'oren'], 'a module\'s write');
    assert.deepEqual(audience('NAMES-NO-AGENT'), ['mira', 'oren'], 'a framework write with no forAgent');
    assert.deepEqual(audience('UNTARGETED'), ['mira', 'oren'], 'a response that asks nobody to read it');
    assert.deepEqual(audience('ASKS-EVERYONE'), ['mira', 'oren'], 'requestInference: true wakes every resident, and is for every one');
    assert.deepEqual(audience('ASKS-NOBODY'), ['mira', 'oren'], 'an empty list names no agent');
    // Named: as named, and so told apart from the writes above.
    assert.deepEqual(audience('FOR-MIRA'), ['mira'], 'forAgent: the primary, by name');
    assert.deepEqual(audience('ASKS-OREN'), ['oren'], 'requestInference: [oren] (it was [\'mira\'])');
    assert.deepEqual(audience('ASKS-OREN-TWICE-AND-A-STRANGER'), ['oren'], 'the registered agents it names, once each');
    assert.deepEqual(audience('ASKS-A-STRANGER'), ['mira'], 'none of them registered: the agent it is delivered to');

    // Stored in the residents' slot all the same, and oren was woken to read his.
    assert.deepEqual(rowsOf(framework, 'oren').map((r) => r.id), rowsOf(framework, 'mira').map((r) => r.id));
    assert.ok(membrane.callsFor('oren').some((call) => JSON.stringify(call.messages).includes('ASKS-OREN')), 'oren read it');
  });

  it('a write that carries a tune-out\'s hold is for nobody, whomever its response asks to read it', async () => {
    const framework = await boot();
    const apply = (framework as unknown as {
      applyProcessResponse(response: EventResponse, event: ProcessEvent, moduleName: string, surface: undefined, step: { at: string }): Promise<void>;
    }).applyProcessResponse.bind(framework);
    await apply({
      addMessages: [{ participant: 'user', content: [{ type: 'text', text: 'HELD-ASKS-OREN' }], metadata: { tuneOut: { epochId: 'e1' }, channelId: 'c' } }],
      requestInference: ['oren'],
    }, surfaceInput('HELD-ASKS-OREN'), 'surface', undefined, { at: '' });
    assert.deepEqual(rowNamed(framework, 'HELD-ASKS-OREN')?.metadata?.audience, [], 'for nobody: no resident is shown it');
  });
});
