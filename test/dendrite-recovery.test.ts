/**
 * The registry's recovery when a write fails or a process dies on the way:
 *
 * - a change that failed and was put back leaves no recovery file holding it
 *   (an end already appended to the branch-local ended log stays), and a
 *   put-back that fails too doesn't hide the change's error;
 * - an agent whose end was written before the snapshot let go of it ends once
 *   at the next boot, and its recipient isn't told of a restart it didn't meet;
 * - an interrupted job's recipient is told even when the boot that found it
 *   dies before telling, and told once when the boot that told dies before
 *   writing the end;
 * - an app-owned store names its recovery files, and is warned without them;
 * - a recovery file that holds null, or a registry without its counters, is
 *   refused rather than read as empty;
 * - a worker's namespace is where its context opens, and belongs to it;
 * - an agent that ended past the registry's memory is still found;
 * - a finished orphan's held result is told of and can be adopted;
 * - a cancelled job's caller hears who cancelled it and why.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, AgentStoppedError, workerSpec } from '../src/index.js';
import type { AgentSpec } from '../src/index.js';
import { AgentRegistry } from '../src/dendrite/registry.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';

const REGISTRY = 'framework/dendrite';
const ENDED = 'framework/dendrite/ended';

/** Make a store method throw for one state id while `when` says so, until the returned undo runs. */
function failOn(store: JsStore, method: 'setStateJson' | 'appendToStateJson', stateId: string, when: () => boolean = () => true): () => void {
  const original = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!.bind(store);
  Object.defineProperty(store, method, {
    configurable: true, writable: true,
    value: (...args: unknown[]) => {
      if (args[0] === stateId && when()) throw new Error(`EIO: simulated ${method} failure`);
      return original(...args);
    },
  });
  return () => { delete (store as unknown as Record<string, unknown>)[method]; };
}

const textOf = (content: ContentBlock[]) => content.map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join('');
const rowsWith = (framework: AgentFramework, agent: string, needle: string) =>
  framework.getAgent(agent)!.getContextManager().getAllMessages().filter((m) => textOf(m.content).includes(needle));

describe('the registry\'s recovery', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let frameworks: AgentFramework[];
  let stores: JsStore[];
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'dendrite-recovery-')); membrane = new RoutedMembrane(); frameworks = []; stores = []; });
  afterEach(async () => {
    for (const framework of frameworks.reverse()) { try { await framework.stop(); } catch { /* already stopped */ } }
    for (const store of stores) { try { store.close(); } catch { /* closed */ } }
    rmSync(tempDir, { recursive: true, force: true });
  });
  const storePath = () => join(tempDir, 'store.chronicle');
  const registryFile = () => join(storePath(), 'recovery', 'dendrite-registry.json');
  const endedFile = () => join(storePath(), 'recovery', 'dendrite-ended.json');

  async function boot(gates = new GateModule(), options: Partial<FrameworkConfig> = {}, agents = ['mira', 'oren']): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      ...(options.store ? {} : { storePath: storePath() }),
      membrane: membrane.asMembrane(),
      agents: agents.map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.` })),
      modules: [gates], syncIntervalMs: 0,
      ...options,
    } as FrameworkConfig);
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

  it('a registry recovery file that holds null is refused, not read as no registry, and stays as it was', async () => {
    const first = await boot();
    await first.stop();
    writeFileSync(registryFile(), 'null');
    await assert.rejects(boot(), /the agent registry \(.*dendrite-registry\.json\) reads as something other than a version-1 registry \(null\)/);
    assert.equal(readFileSync(registryFile(), 'utf8'), 'null', 'the file is unchanged');
  });

  it('a version-1 registry without its map of incarnations is refused', async () => {
    const first = await boot();
    await first.stop();
    const stored = JSON.parse(readFileSync(registryFile(), 'utf8')) as Record<string, unknown>;
    delete stored.incarnations;
    writeFileSync(registryFile(), JSON.stringify(stored));
    await assert.rejects(boot(), /reads as a version-1 registry with no map of incarnations/);
  });

  it('a stop whose branch-local write fails leaves the recovery file as memory is: the agent live', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    await startBlocked(first, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const undo = failOn(first.getStore(), 'setStateJson', REGISTRY);
    try {
      assert.throws(() => first.stopAgent('boss', { by: 'mira' }), /EIO: simulated setStateJson failure/);
    } finally { undo(); }
    assert.equal(first.getAgentRecord('boss')?.ended, undefined, 'boss is live in memory');
    const file = JSON.parse(readFileSync(registryFile(), 'utf8')) as { records: Array<{ name: string; ended?: unknown }> };
    assert.ok(file.records.some((r) => r.name === 'boss' && r.ended === undefined), 'and in the recovery file that wins at boot');
    const ended = JSON.parse(readFileSync(endedFile(), 'utf8')) as { ended: Array<{ name: string }> };
    assert.equal(ended.ended.filter((r) => r.name === 'boss').length, 0, 'and its end is off the ended file');
  });

  it('a hold whose branch-local write fails is in no copy of the registry, so a retry holds it once', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    await startBlocked(first, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const job = await startBlocked(first, gates, 'job', 'g-job', workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }));
    first.stopAgent('boss', { by: 'mira' });
    gates.release('g-job');
    assert.ok((await job.settled).ok);
    const undo = failOn(first.getStore(), 'setStateJson', REGISTRY);
    try {
      assert.throws(() => first.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-1' }]), /EIO: simulated setStateJson failure/);
    } finally { undo(); }
    const file = JSON.parse(readFileSync(registryFile(), 'utf8')) as { mail: unknown[] };
    assert.equal(file.mail.length, 0, 'the recovery file holds no copy of the failed hold');
    first.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-1' }]);
    assert.equal(first.listHeldMail().length, 1, 'and the retry holds it once');
  });

  it('a put-back rewrites every recovery file, one failing or not', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    await startBlocked(first, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const store = first.getStore();
    // The ended file's rewrite fails during the put-back: the registry file's still happens.
    const internal = first as unknown as { writeRecoveryFile: (path: string, document: unknown) => void };
    const write = internal.writeRecoveryFile.bind(first);
    let putBack = false;
    internal.writeRecoveryFile = (path, document) => {
      if (putBack && path === endedFile()) throw new Error('EIO: the ended file');
      write(path, document);
    };
    const undo = failOn(store, 'setStateJson', REGISTRY, () => { putBack = true; return true; });
    try {
      assert.throws(() => first.stopAgent('boss', { by: 'mira' }), /EIO: simulated setStateJson failure/);
    } finally {
      undo();
      delete (first as unknown as Record<string, unknown>).writeRecoveryFile;
    }
    const file = JSON.parse(readFileSync(registryFile(), 'utf8')) as { records: Array<{ name: string; ended?: unknown }> };
    assert.ok(file.records.some((r) => r.name === 'boss' && r.ended === undefined), 'the registry file is rewritten from memory, not left as the stop wrote it');
  });

  it('when the put-back fails too, the caller still hears why its change failed', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    await startBlocked(first, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const internal = first as unknown as { writeRecoveryFile: (path: string, document: unknown) => void };
    const write = internal.writeRecoveryFile.bind(first);
    let putBack = false;
    internal.writeRecoveryFile = (path, document) => {
      if (putBack) throw new Error('EIO: the put-back failed');
      write(path, document);
    };
    const undo = failOn(first.getStore(), 'setStateJson', REGISTRY, () => { putBack = true; return true; });
    try {
      assert.throws(() => first.stopAgent('boss', { by: 'mira' }), /EIO: simulated setStateJson failure/);
    } finally {
      undo();
      delete (first as unknown as Record<string, unknown>).writeRecoveryFile;
    }
  });

  it('an end written before the snapshot let go of the agent ends it once at the next boot, and tells nobody of a restart', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    const job = await startBlocked(first, gates, 'w', 'g-w', workerSpec('w', { spawnedBy: 'oren', resultTo: { to: 'oren', as: 'message' } }));
    const whileLive = readFileSync(registryFile(), 'utf8');
    gates.release('g-w');
    assert.ok((await job.settled).ok);
    assert.equal(first.getAgentRecord('w')?.ended?.reason, 'completed');
    await first.stop();
    // The previous process wrote w's end and died before the snapshot without w.
    writeFileSync(registryFile(), whileLive);
    const second = await boot();
    const records = second.listAgents({ includeEnded: true }).filter((r) => r.name === 'w');
    assert.deepEqual(records.map((r) => r.ended?.reason), ['completed'], 'w ended once, as it did');
    assert.deepEqual(rowsWith(second, 'oren', 'the host restarted while'), [], 'and oren is told of no restart');
  });

  it('an interrupted job\'s recipient is told even when the boot that found it dies before telling, and told once', async () => {
    const store = JsStore.openOrCreate({ path: storePath() });
    stores.push(store);
    const paths = { agentRegistryPath: join(tempDir, 'registry.json'), agentRegistryEndedPath: join(tempDir, 'ended.json') };
    const gates = new GateModule();
    const first = await boot(gates, { store, ...paths });
    first.start();
    await startBlocked(first, gates, 'w', 'g-w', workerSpec('w', { spawnedBy: 'oren', resultTo: { to: 'oren', as: 'message' } }));
    assert.ok(existsSync(paths.agentRegistryPath), 'the app-owned store\'s registry recovery file is where it was named');
    // The process dies with w live; the next boot dies too, after the restore
    // and before it tells oren (its conversations name a template it doesn't run).
    await assert.rejects(
      boot(new GateModule(), { store, ...paths, conversations: { templateAgent: 'nobody' } as FrameworkConfig['conversations'] }),
      /conversations\.templateAgent "nobody" is not a configured agent/,
    );
    // The next boot tells oren and dies before writing w's end.
    const settle = AgentRegistry.prototype.settleInterrupted;
    AgentRegistry.prototype.settleInterrupted = function settleNothing() { /* the process dies here */ };
    let third: AgentFramework;
    try {
      third = await boot(new GateModule(), { store, ...paths });
    } finally { AgentRegistry.prototype.settleInterrupted = settle; }
    assert.equal(rowsWith(third, 'oren', 'the host restarted while "w"').length, 1, 'oren is told');
    assert.equal(third.getAgentRecord('w')?.ended?.reason, 'host-restart');
    // The one after finds the notice and doesn't tell it twice, and writes w's end.
    const fourth = await boot(new GateModule(), { store, ...paths });
    assert.equal(rowsWith(fourth, 'oren', 'the host restarted while "w"').length, 1, 'oren is told once');
    assert.equal(fourth.listAgents({ includeEnded: true }).filter((r) => r.name === 'w').length, 1, 'and w ended once');
    assert.ok(existsSync(paths.agentRegistryEndedPath), 'its end is in the ended recovery file named for it');
    assert.ok(!(JSON.parse(readFileSync(paths.agentRegistryPath, 'utf8')) as { records: Array<{ name: string }> }).records.some((r) => r.name === 'w'), 'and the registry no longer lists it');
  });

  it('an app-owned store with neither a storePath nor the recovery paths is warned at create', async () => {
    const store = JsStore.openOrCreate({ path: storePath() });
    stores.push(store);
    const said: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { said.push(args.map(String).join(' ')); };
    try {
      await boot(new GateModule(), { store });
    } finally { console.error = error; }
    assert.ok(said.some((line) => line.includes('[dendrite] no storePath / agentRegistryPath / agentRegistryEndedPath')), said.join('\n'));
  });

  it('a worker\'s named namespace is where its context opens, so inspection reads what it wrote', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    membrane.script('w', say('done'));
    const { agent, contextManager } = await first.createEphemeralAgent(
      { name: 'w', model: 'test-model', systemPrompt: 'Do the task.' },
      workerSpec('w', { namespace: 'jobs/w' }),
    );
    contextManager.addMessage('user', [{ type: 'text', text: 'Go. NS-MARK' }]);
    await first.runEphemeralToCompletion(agent, contextManager);
    assert.equal(first.getAgentRecord('w')?.namespace, 'jobs/w');
    const inspected = await first.inspectAgentContext('w');
    assert.ok(inspected.getAllMessages().some((m) => textOf(m.content).includes('NS-MARK')), 'the inspected context is the one it ran in');
  });

  it('a namespace belongs to the agent that opened it: another agent\'s is refused, live, a candidate or ended', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    const create = (name: string, namespace: string) =>
      first.createEphemeralAgent({ name, model: 'test-model', systemPrompt: 'x' }, workerSpec(name, { namespace }));
    await startBlocked(first, gates, 'w1', 'g-w1', workerSpec('w1', { namespace: 'jobs/shared' }));
    await assert.rejects(create('w2', 'jobs/shared'), /namespace "jobs\/shared" holds the context of agent "w1"/);
    await assert.rejects(create('w3', 'agents/mira'), /holds the context of agent "mira"/, 'a resident\'s namespace is held too');
    await create('c1', 'jobs/candidate');
    await assert.rejects(create('c2', 'jobs/candidate'), /holds the context of agent "c1"; name another, or none for subagent\/c2$/, 'so is a candidate\'s not yet run');
    // Where the refused namespace is the default, the default isn't offered.
    await create('c3', 'subagent/c4');
    await assert.rejects(
      first.createEphemeralAgent({ name: 'c4', model: 'test-model', systemPrompt: 'x' }, workerSpec('c4')),
      /namespace "subagent\/c4" holds the context of agent "c3"; name another$/,
    );
    first.stopAgent('w1', { by: 'mira' });
    await assert.rejects(create('w4', 'jobs/shared'), /holds the context of agent "w1"/, 'and an ended agent\'s');
  });

  it('after a restart an agent reopens its own namespace, and another can\'t, from memory or from the ended log', async () => {
    const first = await boot();
    first.start();
    membrane.script('w5', say('done'));
    const run = await first.createEphemeralAgent({ name: 'w5', model: 'test-model', systemPrompt: 'x' }, workerSpec('w5', { namespace: 'jobs/five' }));
    run.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    await first.runEphemeralToCompletion(run.agent, run.contextManager);
    await first.stop();
    // Past the registry's memory: an agent's end, and a shared fork's, whose
    // record names its parent's namespace (it owns a branch there, not the namespace).
    const ended = (name: string, i: number) => ({
      name, kind: 'worker', incarnation: 1, onParentEnd: 'orphan', readsSharedSlot: false,
      roles: { defaultDelivery: false, receivesUntargeted: false, receivesGateWakes: false, ownsProviderScheduling: false },
      lifetime: { kind: 'task', idleTimeoutMs: 1000 }, relationships: { observes: [], messagePeers: [] },
      createdAt: i, ended: { at: i + 1, reason: 'completed' },
    });
    const store = JsStore.openOrCreate({ path: storePath() });
    try {
      store.appendToStateJson(ENDED, { ...ended('old-0', 0), namespace: 'jobs/old' });
      store.appendToStateJson(ENDED, { ...ended('fork-0', 1), namespace: 'jobs/parent', inherit: { from: 'parent-0', mode: 'shared' } });
      store.sync();
    } finally { store.close(); }
    const second = await boot();
    second.start();
    const create = (name: string, namespace: string) =>
      second.createEphemeralAgent({ name, model: 'test-model', systemPrompt: 'x' }, workerSpec(name, { namespace }));
    await assert.rejects(create('w6', 'jobs/five'), /holds the context of agent "w5"/, 'held by an end in memory');
    await assert.rejects(create('w7', 'jobs/old'), /holds the context of agent "old-0"/, 'held by an end in the ended log alone');
    await create('w8', 'jobs/parent');
    membrane.script('w5', say('again'));
    const again = await create('w5', 'jobs/five');
    again.contextManager.addMessage('user', [{ type: 'text', text: 'Go again.' }]);
    await second.runEphemeralToCompletion(again.agent, again.contextManager);
    assert.equal(second.getAgentRecord('w5')?.incarnation, 2, 'its own namespace, in a new incarnation');
  });

  it('an agent that ended past the registry\'s memory is found in the ended log', async () => {
    const first = await boot();
    await first.stop();
    const store = JsStore.openOrCreate({ path: storePath() });
    try {
      for (let i = 0; i < 300; i++) {
        store.appendToStateJson(ENDED, {
          name: `old-${i}`, kind: 'worker', incarnation: 1, onParentEnd: 'orphan', readsSharedSlot: false,
          roles: { defaultDelivery: false, receivesUntargeted: false, receivesGateWakes: false, ownsProviderScheduling: false },
          lifetime: { kind: 'task', idleTimeoutMs: 1000 }, relationships: { observes: [], messagePeers: [] },
          createdAt: i, ended: { at: i + 1, reason: 'completed' },
        });
      }
      store.sync();
    } finally { store.close(); }
    const second = await boot();
    assert.equal(second.getAgentRecord('old-0')?.ended?.reason, 'completed', 'the oldest is still found');
    assert.equal(second.getAgentRecord('never-was'), null);
  });

  it('the ended log\'s index follows a log that changed under it, as long or shorter', async () => {
    const first = await boot();
    await first.stop();
    const ended = (name: string, i: number) => ({
      name, kind: 'worker', incarnation: 1, onParentEnd: 'orphan', readsSharedSlot: false,
      roles: { defaultDelivery: false, receivesUntargeted: false, receivesGateWakes: false, ownsProviderScheduling: false },
      lifetime: { kind: 'task', idleTimeoutMs: 1000 }, relationships: { observes: [], messagePeers: [] },
      createdAt: i, ended: { at: i + 1, reason: 'completed' },
    });
    const store = JsStore.openOrCreate({ path: storePath() });
    try {
      for (let i = 0; i < 300; i++) store.appendToStateJson(ENDED, ended(`old-${i}`, i));
      store.sync();
    } finally { store.close(); }
    const second = await boot();
    assert.equal(second.getAgentRecord('old-0')?.ended?.reason, 'completed', 'the index is built');
    // A branch switch puts another ended log in its place: as long, then shorter.
    const live = second.getStore() as unknown as Record<string, (...args: unknown[]) => unknown>;
    const len = live.getStateLen!.bind(live);
    const item = live.getStateItemJson!.bind(live);
    for (const [prefix, count] of [['other', 300], ['short', 100]] as const) {
      const log = Array.from({ length: count }, (_, i) => ended(`${prefix}-${i}`, 1000 + i));
      Object.defineProperty(live, 'getStateLen', { configurable: true, writable: true, value: (id: string) => (id === ENDED ? log.length : len(id)) });
      Object.defineProperty(live, 'getStateItemJson', { configurable: true, writable: true, value: (id: string, i: number) => (id === ENDED ? log[i] ?? null : item(id, i)) });
      assert.equal(second.getAgentRecord(`${prefix}-5`)?.ended?.reason, 'completed', `a name only on the ${prefix} log is found`);
    }
    delete live.getStateLen;
    delete live.getStateItemJson;
  });

  it('a finished orphan\'s held result is told of, and adopting the ended orphan delivers it', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    await startBlocked(first, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const job = await startBlocked(first, gates, 'job', 'g-job', workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }), 'job result');
    first.stopAgent('boss', { by: 'mira' });
    gates.release('g-job');
    assert.ok((await job.settled).ok, 'the orphaned job finishes');
    first.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-1' }]);
    assert.deepEqual(first.listHeldMail().map((m) => [m.to, m.heldBecause]), [['boss', 'recipient-gone']]);
    assert.equal(rowsWith(first, 'oren', 'reparenting "job" to you delivers it').length, 1, 'the first candidate is told the result is held');
    const record = first.reparentAgent('job', 'oren', { by: 'oren' });
    assert.equal(record.ended?.reason, 'completed', 'the record stays as it ended');
    assert.equal(rowsWith(first, 'oren', 'RESULT-1').length, 1, 'and the result reaches oren');
  });

  it('an orphan that ends with a result it delivered while it ran still held tells its first candidate', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    await startBlocked(first, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const job = await startBlocked(first, gates, 'job', 'g-job', workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }), 'job result');
    first.stopAgent('boss', { by: 'mira' });
    first.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-1' }]);
    assert.deepEqual(first.listHeldMail().map((m) => [m.to, m.heldBecause]), [['boss', 'recipient-gone']]);
    assert.equal(rowsWith(first, 'oren', 'reparenting "job" to you delivers it').length, 0, 'not while it runs: the adoption offer covers that');
    gates.release('g-job');
    assert.ok((await job.settled).ok);
    assert.equal(rowsWith(first, 'oren', 'reparenting "job" to you delivers it').length, 1, 'told once it has ended');
  });

  it('a job cancelled with its stream in flight rejects with AgentStoppedError naming who and why', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    const worker = await startBlocked(first, gates, 'w', 'g-w', workerSpec('w', { spawnedBy: 'oren' }));
    assert.equal(first.cancelActivation('w', { by: 'oren', reason: 'changed plans' }), true);
    const result = await worker.settled;
    assert.ok(!result.ok && result.error instanceof AgentStoppedError, `rejected with ${result.ok ? 'nothing' : String(result.error)}`);
    assert.equal((result.error as AgentStoppedError).by, 'oren');
    assert.match((result.error as Error).message, /changed plans/);
  });
});
