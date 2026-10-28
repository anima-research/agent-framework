/**
 * The registry's recovery when a write fails or a process dies on the way:
 *
 * - a change that failed and was put back leaves no copy of the registry
 *   holding it, and a put-back that fails too doesn't hide the change's error;
 * - an agent whose end was written before the snapshot let go of it ends once
 *   at the next boot, and its recipient isn't told of a restart it didn't meet;
 * - a recovery file that holds null, or a registry without its counters, is
 *   refused rather than read as empty;
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
});
