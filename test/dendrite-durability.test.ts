/**
 * The registry's durable state, after nissa's review of #546 (findings 1 to
 * 5, with their probes on review/546-probes as the shape of each case):
 *
 * 1. A registry that can't be read, or reads as another version, refuses
 *    the start and names the state, rather than being taken as empty and
 *    overwritten.
 * 2. A failed registry write, ended-log append or sync fails the call that
 *    made it; a result whose hold isn't durable is not delivered.
 * 3. The registry and its ended log live in recovery files beside the store,
 *    which win over the branch-local state.
 * 4. At a quiesced boot, held mail waits with the deferred queue and lands
 *    once, at resume.
 * 5. stopAgent releases the stopped agent's window as the idle reap does: a
 *    failure notice it never read reaches the primary, and a write queued
 *    for it lands in its window.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, workerSpec } from '../src/index.js';
import { STORED_INJECTION_KEY, STORED_INJECTION_KIND } from '../src/stored-injections.js';
import type { AgentSpec, ProcessEvent } from '../src/index.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const REGISTRY = 'framework/dendrite';
const ENDED = 'framework/dendrite/ended';
type Method = 'setStateJson' | 'appendToStateJson' | 'sync';

/** Make one store method throw (for one state id, if given) until the returned undo runs. */
function failOn(store: JsStore, method: Method, stateId?: string, when: (args: unknown[]) => boolean = () => true): () => void {
  const original = (store as unknown as Record<Method, (...args: unknown[]) => unknown>)[method].bind(store);
  Object.defineProperty(store, method, {
    configurable: true, writable: true,
    value: (...args: unknown[]) => {
      if ((stateId === undefined || args[0] === stateId) && when(args)) throw new Error(`EIO: simulated ${method} failure`);
      return original(...args);
    },
  });
  return () => { delete (store as unknown as Record<string, unknown>)[method]; };
}

const textOf = (content: ContentBlock[]) => content.map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join('');
const rowsWith = (framework: AgentFramework, agent: string, needle: string) =>
  framework.getAgent(agent)!.getContextManager().getAllMessages().filter((m) => textOf(m.content).includes(needle));

describe('the registry\'s durable state (findings 1 to 4)', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let frameworks: AgentFramework[];
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'dendrite-durable-')); membrane = new RoutedMembrane(); frameworks = []; });
  afterEach(async () => {
    for (const framework of frameworks.reverse()) { try { await framework.stop(); } catch { /* already stopped */ } }
    rmSync(tempDir, { recursive: true, force: true });
  });
  const storePath = () => join(tempDir, 'store.chronicle');
  const registryFile = () => join(storePath(), 'recovery', 'dendrite-registry.json');
  const endedFile = () => join(storePath(), 'recovery', 'dendrite-ended.json');

  async function boot(gates = new GateModule()): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: storePath(), membrane: membrane.asMembrane(),
      agents: [
        { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' },
        { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.' },
      ],
      modules: [gates], syncIntervalMs: 0,
    });
    frameworks.push(framework);
    return framework;
  }
  async function startBlocked(framework: AgentFramework, gates: GateModule, name: string, gate: string, spec: Omit<AgentSpec, 'name'>, finalText = `${name} done`) {
    membrane.script(name, waitCall(gate), say(finalText));
    const { agent, contextManager } = await framework.createEphemeralAgent({ name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' }, spec);
    contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    const settled = framework.runEphemeralToCompletion(agent, contextManager).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    await until(() => gates.entered.has(gate), `${name} to block on ${gate}`);
    return { settled };
  }
  /** The orphan flow: boss starts job, boss is stopped, job finishes, its result is held for adoption. */
  async function heldResult(framework: AgentFramework, gates: GateModule, hooks: { beforeStop?: () => void; beforeHold?: () => void } = {}) {
    framework.start();
    await startBlocked(framework, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const job = await startBlocked(framework, gates, 'job', 'g-job', workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }), 'job result');
    hooks.beforeStop?.();
    framework.stopAgent('boss', { by: 'mira' });
    gates.release('g-job');
    assert.ok((await job.settled).ok, 'the orphaned job finishes');
    hooks.beforeHold?.();
    return framework.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-1' }]);
  }

  it('3: the registry and its ended log are recovery files beside the store, and the file wins over the branch-local state', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    await heldResult(first, gates);
    assert.deepEqual(first.listHeldMail().map((m) => [m.to, m.heldBecause]), [['boss', 'recipient-gone']]);
    await first.stop();
    assert.ok(existsSync(registryFile()) && existsSync(endedFile()), 'both recovery files exist');
    const file = JSON.parse(readFileSync(registryFile(), 'utf8')) as { version: number; mail: unknown[] };
    assert.equal(file.version, 1);
    assert.equal(file.mail.length, 1, 'the held result is in the file');
    assert.ok((JSON.parse(readFileSync(endedFile(), 'utf8')) as { ended: Array<{ name: string }> }).ended.some((r) => r.name === 'boss'));
    // The branch-local copy is damaged (as a branch switch would leave it stale): the file still wins.
    const store = JsStore.openOrCreate({ path: storePath() });
    try { store.setStateJson(REGISTRY, { version: 1, records: [], mail: [], incarnations: {} }); store.sync(); } finally { store.close(); }
    const second = await boot();
    assert.equal(second.listHeldMail().length, 1, 'the held result survives');
    assert.ok(second.getAgentRecord('boss'), 'boss\'s ended record is inspectable');
  });

  for (const [label, damage] of [
    ['1a, a registry stored in another version', () => {
      const stored = JSON.parse(readFileSync(registryFile(), 'utf8')) as Record<string, unknown>;
      writeFileSync(registryFile(), JSON.stringify({ ...stored, version: 2 }));
    }],
    ['1b, a registry whose read fails', () => { writeFileSync(registryFile(), '{"version":1,"records":['); }],
  ] as const) {
    it(`${label}: create() refuses and names the state; nothing is overwritten`, async () => {
      const gates = new GateModule();
      const first = await boot(gates);
      await heldResult(first, gates);
      await first.stop();
      damage();
      const before = readFileSync(registryFile(), 'utf8');
      await assert.rejects(boot(), (error: Error) => {
        assert.match(error.message, /the agent registry \(.*dendrite-registry\.json\) (can't be read|reads as something other than a version-1 registry)/);
        assert.match(error.message, /doesn't start without it/);
        return true;
      });
      assert.equal(readFileSync(registryFile(), 'utf8'), before, 'the file is unchanged');
    });
  }

  it('2a: a failed registry write or ended-log append fails the call that made it, and nothing claims success', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    const store = first.getStore();
    first.start();
    await startBlocked(first, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const job = await startBlocked(first, gates, 'job', 'g-job', workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }), 'job result');
    let undo = failOn(store, 'appendToStateJson', ENDED);
    try {
      assert.throws(() => first.stopAgent('boss', { by: 'mira' }), /EIO: simulated appendToStateJson failure/, 'the stop fails with the append');
    } finally { undo(); }
    // The stop that failed changed nothing: boss is live, and the next stop ends it once.
    assert.equal(first.getAgentRecord('boss')?.ended, undefined);
    first.stopAgent('boss', { by: 'mira' });
    gates.release('g-job');
    assert.ok((await job.settled).ok);
    undo = failOn(store, 'setStateJson', REGISTRY);
    try {
      assert.throws(() => first.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-1' }]), /EIO: simulated setStateJson failure/, 'holding the result fails with the write');
    } finally { undo(); }
    const delivered = first.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-1' }]);
    assert.equal(delivered.delivered, false, 'held for the gone recipient');
    assert.equal(first.listHeldMail().length, 1);
  });

  it('2b: the hold is durable as written, so a failed sync delays the release, never the delivery', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    const job = await startBlocked(first, gates, 'job2', 'g-job2', workerSpec('job2', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }), 'job2 result');
    gates.release('g-job2');
    assert.ok((await job.settled).ok);
    const undo = failOn(first.getStore(), 'sync');
    let delivery: { delivered: boolean };
    try { delivery = first.deliverAgentResult('job2', [{ type: 'text', text: 'RESULT-2' }]); } finally { undo(); }
    assert.equal(delivery.delivered, true, 'delivered: the hold was durable before it');
    assert.equal(rowsWith(first, 'mira', 'RESULT-2').length, 1);
    assert.equal(first.listHeldMail().filter((m) => m.to === 'mira').length, 1, 'held until a sync carries the message');
    const file = JSON.parse(readFileSync(registryFile(), 'utf8')) as { mail: unknown[] };
    assert.equal(file.mail.length, 1, 'the hold is in the recovery file');
  });

  it('4: at a quiesced boot, held mail waits with the deferred queue and lands once, at resume', async () => {
    const first = await boot();
    await first.quiesce({ reason: 'maintenance' });
    first.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'MAIL-1' }]);
    (first as unknown as { addMessage(p: string, c: ContentBlock[], m?: Record<string, unknown>, o?: { forAgent?: string }): string })
      .addMessage('user', [{ type: 'text', text: 'PLAIN-1' }], { kind: 'test-note' }, { forAgent: 'mira' });
    assert.equal(rowsWith(first, 'mira', 'MAIL-1').length, 0, 'held by the quiesce');
    assert.equal(first.listHeldMail().length, 1);
    await first.stop();
    const second = await boot();
    assert.equal(second.getHostModeStatus().quiesced, true, 'boots quiesced');
    assert.equal(rowsWith(second, 'mira', 'MAIL-1').length, 0, 'the mail waits with the queue');
    assert.equal(rowsWith(second, 'mira', 'PLAIN-1').length, 0);
    await second.resume();
    assert.equal(rowsWith(second, 'mira', 'PLAIN-1').length, 1);
    assert.equal(rowsWith(second, 'mira', 'MAIL-1').length, 1, 'the mail lands once, at resume');
    assert.equal(second.listHeldMail().length, 0, 'and is released');
  });
});

describe('round 2: a change is put back when its write fails; a record of what happened is not failed; the release waits for the sync', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let frameworks: AgentFramework[];
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'dendrite-durable2-')); membrane = new RoutedMembrane(); frameworks = []; });
  afterEach(async () => {
    for (const framework of frameworks.reverse()) { try { await framework.stop(); } catch { /* already stopped */ } }
    rmSync(tempDir, { recursive: true, force: true });
  });
  const storePath = () => join(tempDir, 'store.chronicle');
  async function boot(gates = new GateModule(), agents = ['mira', 'oren']): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: storePath(), membrane: membrane.asMembrane(),
      agents: agents.map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.` })),
      modules: [gates], syncIntervalMs: 0,
    });
    frameworks.push(framework);
    return framework;
  }
  async function startBlocked(framework: AgentFramework, gates: GateModule, name: string, gate: string, spec: Omit<AgentSpec, 'name'>, finalText = `${name} done`) {
    membrane.script(name, waitCall(gate), say(finalText));
    const { agent, contextManager } = await framework.createEphemeralAgent({ name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' }, spec);
    contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    const settled = framework.runEphemeralToCompletion(agent, contextManager).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    await until(() => gates.entered.has(gate), `${name} to block on ${gate}`);
    return { settled };
  }

  it('T: a stop whose write fails changes nothing — the agent stays live, and a second stop ends it once', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    await startBlocked(first, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const undo = failOn(first.getStore(), 'appendToStateJson', ENDED);
    try {
      assert.throws(() => first.stopAgent('boss', { by: 'mira' }), /EIO: simulated appendToStateJson failure/);
    } finally { undo(); }
    assert.equal(first.getAgentRecord('boss')?.ended, undefined, 'still live: the failed stop was put back');
    const outcome = first.stopAgent('boss', { by: 'mira' });
    assert.equal(outcome.ended.name, 'boss');
    assert.equal(first.getAgentRecord('boss')?.ended?.reason, 'stopped');
  });

  it('R and K: a release whose write fails is not a failed delivery, and a release is written only once the store has synced', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    const job = await startBlocked(first, gates, 'job', 'g-job', workerSpec('job', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }), 'job result');
    gates.release('g-job');
    assert.ok((await job.settled).ok);
    // K: the store's sync fails as the message lands, so the release is not written and the mail stays held.
    let undo = failOn(first.getStore(), 'sync');
    let delivery: { delivered: boolean };
    try { delivery = first.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-K' }]); } finally { undo(); }
    assert.equal(delivery.delivered, true, 'in the window');
    assert.equal(rowsWith(first, 'mira', 'RESULT-K').length, 1);
    assert.equal(first.listHeldMail().length, 1, 'held until a sync carries the message');
    // The next boot's check of the recipient's store settles it, once.
    await first.stop();
    const second = await boot(gates);
    assert.equal(rowsWith(second, 'mira', 'RESULT-K').length, 1, 'once');
    assert.equal(second.listHeldMail().length, 0, 'released by the check');
    // R: a release whose branch-local registry write fails is a record of what happened: no throw, released in memory.
    second.start();
    const job2 = await startBlocked(second, gates, 'job2', 'g-job2', workerSpec('job2', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }), 'job2 result');
    gates.release('g-job2');
    assert.ok((await job2.settled).ok);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    // Only the release's write fails: the snapshot with no mail left in it.
    undo = failOn(second.getStore(), 'setStateJson', REGISTRY, (args) => ((args[1] as { mail?: unknown[] }).mail ?? []).length === 0);
    let held: { delivered: boolean };
    try { held = second.deliverAgentResult('job2', [{ type: 'text', text: 'RESULT-R' }]); } finally { undo(); console.error = original; }
    assert.equal(held.delivered, true, 'no failure for a record of what happened');
    assert.equal(rowsWith(second, 'mira', 'RESULT-R').length, 1, 'once');
    assert.equal(second.listHeldMail().length, 0, 'released in memory');
    assert.ok(errors.some((e) => /could not record the release of mail/.test(e)), 'and the failure is alerted');
  });

  it('U: a run\'s own end is a record of what happened — a failed write alerts, the run still settles, the record is ended', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    const job = await startBlocked(first, gates, 'job', 'g-job', workerSpec('job', { spawnedBy: 'mira' }), 'job result');
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    const undo = failOn(first.getStore(), 'setStateJson', REGISTRY);
    let done: { ok: boolean };
    try { gates.release('g-job'); done = await job.settled; } finally { undo(); console.error = original; }
    assert.equal(done.ok, true, 'the run finished, and says so');
    assert.equal(first.getAgentRecord('job')?.ended?.reason, 'completed', 'ended in the registry');
    assert.equal(first.getAgent('job'), null);
    assert.ok(errors.some((e) => /could not record a change already made/.test(e)), 'the write failure is alerted');
  });

  it('T, the ended log: an end that was put back comes off the recovery file too', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    await startBlocked(first, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    // The snapshot's write fails after the ended record was appended.
    const undo = failOn(first.getStore(), 'setStateJson', REGISTRY);
    try { assert.throws(() => first.stopAgent('boss', { by: 'mira' })); } finally { undo(); }
    first.stopAgent('boss', { by: 'mira' });
    const ended = (JSON.parse(readFileSync(join(storePath(), 'recovery', 'dendrite-ended.json'), 'utf8')) as { ended: Array<{ name: string; ended: { reason: string } }> }).ended;
    assert.equal(ended.filter((r) => r.name === 'boss').length, 1, 'one stopped record for the one stop that held');
  });

  it('a version-1 registry whose records or mail are not lists is refused, not taken as empty', async () => {
    const first = await boot();
    await first.stop();
    const file = join(storePath(), 'recovery', 'dendrite-registry.json');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...stored, mail: 'none' }));
    await assert.rejects(boot(), /the agent registry \(.*dendrite-registry\.json\) reads as a version-1 registry whose records or mail are not lists/);
  });

  it('a resident dropped from the configuration reopens with what it read of the shared slot', async () => {
    const first = await boot(new GateModule(), ['mira', 'nova']);
    for (let i = 0; i < 6; i++) first.getAgent('nova')!.getContextManager().addMessage('user', [{ type: 'text', text: `shared ${i}` }]);
    assert.equal(first.getAgent('mira')!.getContextManager().getAllMessages().length, 6, 'residents share the slot');
    await first.stop();
    const second = await boot(new GateModule(), ['mira']);
    const nova = second.getAgentRecord('nova');
    assert.equal(nova?.ended?.reason, 'not-configured');
    const reopened = await second.inspectAgentContext('nova');
    assert.equal(reopened.getAllMessages().length, 6, 'reopened on the shared slot it read');
  });

  it('a dropped resident reopens without a co-resident\'s stored context injection, as its live view left it out', async () => {
    const first = await boot(new GateModule(), ['mira', 'nova']);
    const nova = first.getAgent('nova')!.getContextManager();
    for (let i = 0; i < 6; i++) nova.addMessage('user', [{ type: 'text', text: `shared ${i}` }]);
    // A row stored as mira's context: in the shared slot, but mira's, not conversation.
    nova.addMessage('system_context:gates', [{ type: 'text', text: 'mira\'s standing context' }], {
      system: true, kind: STORED_INJECTION_KIND,
      [STORED_INJECTION_KEY]: { agent: 'mira', namespace: 'agents/mira', contentHash: 'h-1', part: 0, parts: 1 },
    });
    // The record holds the row for every reader; each reader's view is what
    // compile() shows it (the view filter is strategy-facing, not the record).
    const shows = async (cm: ContextManager) =>
      (await cm.compile(undefined, undefined, { dryRun: true })).messages.some((m) => textOf(m.content).includes('standing context'));
    assert.equal(nova.getAllMessages().length, 7, 'the one slot holds the row');
    assert.equal(await shows(first.getAgent('mira')!.getContextManager()), true, 'mira\'s view has its own injection');
    assert.equal(await shows(nova), false, 'nova\'s live view leaves it out');
    await first.stop();
    const second = await boot(new GateModule(), ['mira']);
    assert.equal(second.getAgentRecord('nova')?.ended?.reason, 'not-configured');
    const reopened = await second.inspectAgentContext('nova');
    assert.equal(reopened.getAllMessages().length, 7, 'reopened on the shared slot it read');
    assert.equal(await shows(reopened), false, 'and its view, as live, is without mira\'s injection');
    assert.equal(await shows(second.getAgent('mira')!.getContextManager()), true, 'mira still sees its own');
  });
});

describe('5: stopAgent releases the window as the idle reap does', () => {
  let tempDir: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;
  const internals = () => framework as unknown as {
    initializeMcpl(servers: []): Promise<void>;
    activeTurnTokens: Map<string, number>;
    deferredMessages: Array<{ forAgent?: string }>;
    pendingAssistantBlocks: Map<string, unknown[]>;
    lastConversationSweep: number;
    sweepExpiredConversations(): void;
    quiesced: boolean;
    deferredWritesPersisted: boolean;
    unackedDeferredWrites: unknown[];
    flushDeferredWrites(label: string): Promise<void>;
    closingConversationAgents: Set<string>;
    addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): string;
  };
  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-stop-'));
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'), membrane: membrane.asMembrane(),
      agents: [
        { name: 'primary', model: 'test-model', systemPrompt: 'Primary.', proseRouting: 'locus' },
        { name: 'secondary', model: 'test-model', systemPrompt: 'Secondary.' },
      ],
      modules: [], conversations: { templateAgent: 'primary' }, speech: { locus: 'latest-inbound' },
    });
    await internals().initializeMcpl([]);
  });
  afterEach(async () => {
    internals().activeTurnTokens.clear(); internals().pendingAssistantBlocks.clear(); internals().quiesced = false;
    await framework.stop(); rmSync(tempDir, { recursive: true, force: true });
  });
  async function spawnFork() {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Reply from the fork.' }]));
    framework.pushEvent({
      type: 'mcpl:channel-incoming', serverId: 'srv', channelId: 'missing-channel', messageId: 'incoming-1',
      author: { id: 'user-1', name: 'User' }, content: [{ type: 'text', text: 'Hello fork.' }],
      timestamp: new Date().toISOString(), metadata: { channel_type: 'im' }, triggerInference: true,
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    const binding = framework.getConversationRouter()!.getBinding({ serverId: 'srv', channelId: 'missing-channel' });
    assert.ok(binding, 'the incoming DM spawns a conversation fork');
    return framework.getAgent(binding.agentName)!;
  }
  function reap(forkName: string) {
    const state = internals(); state.closingConversationAgents.add(forkName); state.lastConversationSweep = 0; state.sweepExpiredConversations();
  }
  async function forkWindowHas(forkName: string, needle: string): Promise<boolean> {
    const archive = await ContextManager.open({ store: framework.getStore(), namespace: 'conversations/' + forkName, isolate: true, strategy: new PassthroughStrategy() });
    return archive.getAllMessages().some((m) => JSON.stringify(m.content).includes(needle));
  }
  const count = (messages: Array<{ content: unknown }>, needle: string) => messages.filter((m) => JSON.stringify(m.content).includes(needle)).length;

  it('V: an idle reap is a record of what happened — a failed write alerts, the fork is gone, its record ended', async () => {
    const fork = await spawnFork();
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    const undo = failOn(framework.getStore(), 'setStateJson', 'framework/dendrite');
    try { reap(fork.name); } finally { undo(); console.error = original; }
    assert.equal(framework.getAgent(fork.name), null, 'gone');
    assert.equal(framework.getAgentRecord(fork.name)?.ended?.reason, 'idle-ttl', 'ended in the registry');
    assert.ok(errors.some((e) => /could not record a change already made/.test(e)), 'alerted');
  });

  for (const how of ['reap', 'stopAgent'] as const) {
    it(`5a, ${how}: a failure notice the fork stored but never read reaches the primary`, async () => {
      const fork = await spawnFork();
      if (how === 'reap') reap(fork.name); else framework.stopAgent(fork.name, { by: 'test', reason: 'test' });
      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      assert.equal(framework.getAgent(fork.name), null, 'the fork is gone');
      assert.equal(count(messages, '[discord-send-failed]'), 1, 'the release tells the primary');
      if (how === 'stopAgent') assert.equal(framework.getAgentRecord(fork.name)?.ended?.reason, 'stopped');
    });

    it(`5b, ${how}: an ordinary write queued for the fork lands in its window and is acknowledged`, async () => {
      const fork = await spawnFork();
      const state = internals();
      state.deferredWritesPersisted = true;
      state.activeTurnTokens.set(fork.name, 3);
      state.addMessage('user', [{ type: 'text', text: 'queued for the fork' }], { kind: 'test-note' }, { forAgent: fork.name });
      assert.equal(state.deferredMessages.length, 1);
      state.activeTurnTokens.delete(fork.name);
      if (how === 'reap') reap(fork.name); else framework.stopAgent(fork.name, { by: 'test', reason: 'test' });
      assert.equal(framework.getAgent(fork.name), null);
      assert.equal(state.deferredMessages.length, 0, 'released, not left queued');
      assert.equal(state.unackedDeferredWrites.length, 0, 'acknowledged');
      assert.equal(await forkWindowHas(fork.name, 'queued for the fork'), true, 'in its window');
    });
  }
});
