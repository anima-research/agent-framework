/**
 * The registry's recovery when a write fails or a process dies on the way:
 *
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
});
