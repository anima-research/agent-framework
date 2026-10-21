/**
 * What a start does to an existing gate.json given the recipe (agent-framework #654):
 * the three-way merge against the recipe last applied, as a pure function and
 * through EventGate's files, and the wake_add_rule result's word on rules no
 * probe event reaches.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import { lastRecipePath, reconcileLine, reconcileWithRecipe } from '../src/gate/recipe-reconcile.js';
import type { GateConfig, GateEventInfo, GatePolicy } from '../src/gate/types.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const rule = (name: string, pattern: string, behavior: GatePolicy['behavior'] = 'always'): GatePolicy => ({
  name,
  match: { scope: ['external-message'], filter: { type: 'text', pattern } },
  behavior,
});
const catchAll: GatePolicy = { name: 'catch-all', match: { scope: ['external-message'] }, behavior: 'skip' };
const config = (policies: GatePolicy[], defaultBehavior: GateConfig['default'] = 'skip'): GateConfig => ({ policies, default: defaultBehavior });
const names = (c: GateConfig): string[] => c.policies.map((p) => p.name);

describe('reconcileWithRecipe: a start against the recipe last applied', () => {
  const recipe1 = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);

  it('drops a rule the recipe dropped, and brings a renamed one in at its recipe place, ahead of the catch-all', () => {
    const recipe2 = config([rule('dm', 'dm'), rule('agents', 'sync'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(recipe1, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['dm', 'agents', 'catch-all']);
    assert.deepStrictEqual(changes.removed, ['zoo', 'sync']);
    assert.deepStrictEqual(changes.added, ['agents']);
  });

  it("gives an unedited rule the recipe's new definition and order, and keeps a run-time rule before the rule it came before", () => {
    const live = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), rule('runtime', 'runtime'), catchAll]);
    const recipe2 = config([rule('sync', 'sync'), rule('dm', 'dm-v2'), rule('zoo', 'zoo'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['sync', 'dm', 'zoo', 'runtime', 'catch-all']);
    assert.deepStrictEqual(merged.policies[1], rule('dm', 'dm-v2'));
    assert.deepStrictEqual(changes.updated, ['dm']);
    assert.deepStrictEqual(changes.moved, ['sync']);
    assert.strictEqual(changes.orderKept, false);
  });

  it('keeps a rule edited since the last recipe, and names it when the recipe changed or dropped it', () => {
    const live = config([rule('dm', 'dm-edited'), rule('zoo', 'zoo-edited'), rule('sync', 'sync-edited'), catchAll]);
    const recipe2 = config([rule('dm', 'dm'), rule('sync', 'sync-v2'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe2, recipe1);
    assert.deepStrictEqual(merged.policies.map((p) => p.match.filter?.pattern ?? null), ['dm-edited', 'zoo-edited', 'sync-edited', null]);
    assert.deepStrictEqual(changes.keptEdited, ['zoo', 'sync']);
    assert.deepStrictEqual(changes.removed, []);
  });

  it('restores a rule both recipes declare, removed from gate.json since, at its recipe place', () => {
    const live = config([rule('dm', 'dm'), rule('sync', 'sync'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe1, recipe1);
    assert.deepStrictEqual(names(merged), ['dm', 'zoo', 'sync', 'catch-all']);
    assert.deepStrictEqual(changes.restored, ['zoo']);
  });

  it("keeps gate.json's order when a recipe rule was moved in it, as wake_add_rule's position does, with the recipe unchanged", () => {
    const live = config([rule('sync', 'sync'), rule('dm', 'dm'), rule('zoo', 'zoo'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe1, recipe1);
    assert.deepStrictEqual(names(merged), ['sync', 'dm', 'zoo', 'catch-all']);
    assert.strictEqual(changes.orderKept, true);
    assert.deepStrictEqual(changes.moved, []);
  });

  it('puts a rule new to the recipe before the recipe rule that follows it, when gate.json keeps its own order', () => {
    const live = config([rule('sync', 'sync'), rule('dm', 'dm'), rule('zoo', 'zoo'), catchAll]);
    const recipe2 = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), rule('new', 'new'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['sync', 'dm', 'zoo', 'new', 'catch-all']);
    assert.deepStrictEqual(changes.added, ['new']);
  });

  it("gives an unedited default the recipe's, and keeps an edited one, named", () => {
    const followed = reconcileWithRecipe(recipe1, config(recipe1.policies, 'always'), recipe1);
    assert.strictEqual(followed.config.default, 'always');
    assert.deepStrictEqual(followed.changes.defaultChange, { from: 'skip', to: 'always' });
    const edited = reconcileWithRecipe(config(recipe1.policies, 'defer'), config(recipe1.policies, 'always'), recipe1);
    assert.strictEqual(edited.config.default, 'defer');
    assert.strictEqual(edited.changes.defaultKept, 'defer');
  });

  it('without a last recipe, removes and redefines nothing: rules that match the recipe take its order, and the rest are named', () => {
    // What the old appending left: a rule the recipe dropped, one it redefined,
    // and the recipe's renamed rule behind the catch-all.
    const live = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), rule('runtime', 'runtime'), catchAll, rule('agents', 'agents')]);
    const recipe2 = config([rule('dm', 'dm-v2'), rule('agents', 'agents'), catchAll], 'always');
    const { config: merged, changes } = reconcileWithRecipe(live, recipe2, null);
    // The rules it keeps stay in their places, and the recipe's take its order in theirs.
    assert.deepStrictEqual(names(merged), ['dm', 'zoo', 'sync', 'runtime', 'agents', 'catch-all']);
    assert.deepStrictEqual(merged.policies[0], rule('dm', 'dm'));
    assert.strictEqual(merged.default, 'skip');
    assert.deepStrictEqual(changes.differsFromRecipe, ['dm']);
    assert.deepStrictEqual(changes.outsideRecipe, ['zoo', 'sync', 'runtime']);
    assert.deepStrictEqual(changes.moved, ['agents']);
    assert.deepStrictEqual(changes.removed, []);
    const line = reconcileLine(changes);
    assert.match(line ?? '', /moved agents/);
    assert.match(line ?? '', /kept, though the recipe defines it otherwise: dm \(remove such a rule, and the next start restores it from the recipe\)/);
    assert.match(line ?? '', /kept, not in the recipe: zoo, sync, runtime/);
  });

  it('says nothing when the recipe and gate.json agree with the last recipe', () => {
    const { config: merged, changes } = reconcileWithRecipe(recipe1, recipe1, recipe1);
    assert.deepStrictEqual(merged, recipe1);
    assert.strictEqual(reconcileLine(changes), null);
  });
});

describe("EventGate's starts, through gate.json and the recipe kept beside it", () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gate-recipe-'));
    configPath = join(dir, '_config', 'gate.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const start = (initialConfig: GateConfig) => {
    const traces: Array<{ type: string; [key: string]: unknown }> = [];
    const gate = new EventGate({
      configPath,
      initialConfig,
      emitTrace: (t) => traces.push(t as { type: string }),
      addMessage: () => '',
      requestInference: () => {},
      getAgentNames: () => ['agent'],
    });
    return { gate, traces };
  };
  const onDisk = (): GateConfig => JSON.parse(readFileSync(configPath, 'utf-8'));
  const ext = (content: string): GateEventInfo => ({ content, eventType: 'external-message', serverId: 'zulip', channelId: '' });
  const recipe1 = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);
  const recipe2 = config([rule('dm', 'dm-v2'), rule('agents', 'sync'), catchAll]);

  it('records the recipe at the first start, and a restart with a new recipe drops, renames and redefines through it', () => {
    start(recipe1).gate.dispose();
    assert.strictEqual(lastRecipePath(configPath), join(dir, '_config', 'gate.recipe.json'));
    assert.deepStrictEqual(JSON.parse(readFileSync(lastRecipePath(configPath), 'utf-8')), recipe1);

    const { gate, traces } = start(recipe2);
    try {
      assert.deepStrictEqual(names(onDisk()), ['dm', 'agents', 'catch-all']);
      assert.strictEqual(gate.evaluate(ext('zoo')).policyName, 'catch-all');
      assert.strictEqual(gate.evaluate(ext('sync')).policyName, 'agents');
      assert.strictEqual(gate.evaluate(ext('dm-v2')).policyName, 'dm');
      assert.deepStrictEqual(gate.lintShadows(), []);
      const trace = traces.find((t) => t.type === 'gate:config-reconciled');
      assert.deepStrictEqual(trace?.removed, ['zoo', 'sync']);
      assert.deepStrictEqual(trace?.added, ['agents']);
      assert.deepStrictEqual(trace?.updated, ['dm']);
      assert.deepStrictEqual(JSON.parse(readFileSync(lastRecipePath(configPath), 'utf-8')), recipe2);
    } finally {
      gate.dispose();
    }
  });

  it('keeps a recipe rule that wake_add_rule moved, through a restart with the recipe unchanged', () => {
    const first = start(recipe1).gate;
    first.addPolicy(rule('sync', 'sync'), { position: 'prepend' });
    first.dispose();
    start(recipe1).gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['sync', 'dm', 'zoo', 'catch-all']);
  });

  it('restores at its recipe place a recipe rule removed at run time, as the clerk recipe tells its resident', () => {
    const first = start(recipe1).gate;
    assert.strictEqual(first.removePolicy('zoo'), true);
    first.dispose();
    const { gate, traces } = start(recipe1);
    gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['dm', 'zoo', 'sync', 'catch-all']);
    assert.deepStrictEqual(traces.find((t) => t.type === 'gate:config-reconciled')?.restored, ['zoo']);
  });

  it("leaves the next start a state it reads rightly when a stop comes between gate.json's write and the recipe's", () => {
    start(recipe1).gate.dispose();
    const recorded1 = readFileSync(lastRecipePath(configPath), 'utf-8');
    start(recipe2).gate.dispose();
    const afterRestart = onDisk();
    // As if the stop came after gate.json was written and before the recipe was.
    writeFileSync(lastRecipePath(configPath), recorded1);
    start(recipe2).gate.dispose();
    assert.deepStrictEqual(onDisk(), afterRestart);
    assert.deepStrictEqual(JSON.parse(readFileSync(lastRecipePath(configPath), 'utf-8')), recipe2);
  });

  it("leaves a gate.json that doesn't load as it is, and records no recipe", () => {
    mkdirSync(join(dir, '_config'), { recursive: true });
    writeFileSync(configPath, '{ "policies": [ not json');
    start(recipe1).gate.dispose();
    assert.strictEqual(readFileSync(configPath, 'utf-8'), '{ "policies": [ not json');
    assert.strictEqual(existsSync(lastRecipePath(configPath)), false);
  });

  it('names the rules no probe event reaches, such as one scoped to external-message', () => {
    const gate = start(config([
      { name: 'zulip-addressed', match: { scope: ['external-message'], metadataTrue: ['isMention'] }, behavior: 'always' },
      { name: 'mentions', match: { metadataTrue: ['isMention'] }, behavior: 'always' },
    ])).gate;
    try {
      assert.deepStrictEqual(gate.probeUnreached(), ['zulip-addressed']);
    } finally {
      gate.dispose();
    }
  });
});

describe("wake_add_rule's result", () => {
  it('names a rule no probe event reaches, so its rows of default:skip don\'t read as its effect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-wake-add-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [],
      syncIntervalMs: 0,
      gate: { configPath: join(dir, 'gate.json'), config: { policies: [], default: 'skip' } },
    });
    try {
      // The wake tools are the framework's own, dispatched from an agent's turn:
      // call that dispatch, and take its result from the event it pushes.
      const internals = framework as unknown as {
        dispatchWakeRuleToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
        pushEvent(event: { type: string; result?: { success: boolean; data?: unknown } }): void;
      };
      const pushed: Array<{ type: string; result?: { success: boolean; data?: unknown } }> = [];
      internals.pushEvent = (event) => { pushed.push(event); };
      internals.dispatchWakeRuleToolCall('prime', {
        id: 'add-1',
        name: 'wake_add_rule',
        input: { name: 'zulip-addressed', match: { scope: ['external-message'], metadataTrue: ['isMention'] }, behavior: 'always' },
      });
      const result = pushed.find((e) => e.type === 'tool-result')?.result;
      assert.ok(result?.success, JSON.stringify(pushed));
      const data = result!.data as { notProbed?: string[]; note?: string; probes: Array<{ wouldWake: boolean }> };
      assert.deepStrictEqual(data.notProbed, ['zulip-addressed']);
      assert.ok(data.probes.every((p) => !p.wouldWake));
      assert.match(data.note ?? '', /the new rule matches no probe event \(see notProbed\)/);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
