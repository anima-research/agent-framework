/**
 * What a start does to an existing gate.json given the recipe (agent-framework #654):
 * the three-way merge against the recipe last applied, as a pure function and
 * through EventGate's files, and the wake_add_rule result's word on rules no
 * probe event reaches.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import { lastRecipePath, reconcileLine, reconcileWithRecipe } from '../src/gate/recipe-reconcile.js';
import type { RecipeChanges } from '../src/gate/recipe-reconcile.js';
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
const patterns = (c: GateConfig): Array<string | null> => c.policies.map((p) => p.match.filter?.pattern ?? null);

describe('reconcileWithRecipe: a start against the recipe last applied', () => {
  const recipe1 = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);

  it('drops a rule the recipe dropped, and brings a renamed one in at its recipe place, ahead of the catch-all', () => {
    const recipe2 = config([rule('dm', 'dm'), rule('agents', 'sync'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(recipe1, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['dm', 'agents', 'catch-all']);
    assert.deepStrictEqual(changes.removed, ['zoo', 'sync']);
    assert.deepStrictEqual(changes.added, ['agents']);
  });

  it("gives an unedited rule the recipe's new definition and order, and keeps a run-time rule in its place", () => {
    const live = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), rule('runtime', 'runtime'), catchAll]);
    const recipe2 = config([rule('sync', 'sync'), rule('dm', 'dm-v2', 'defer'), rule('zoo', 'zoo'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['sync', 'dm', 'zoo', 'runtime', 'catch-all']);
    assert.deepStrictEqual(merged.policies[1], rule('dm', 'dm-v2', 'defer'));
    assert.deepStrictEqual(changes.updated, ['dm']);
    assert.deepStrictEqual(changes.moved, ['sync']);
    assert.strictEqual(changes.orderKept, false);
  });

  it('keeps a rule edited since the last recipe, and names it when the recipe changed or dropped it', () => {
    const live = config([rule('dm', 'dm-edited'), rule('zoo', 'zoo-edited'), rule('sync', 'sync-edited'), catchAll]);
    const recipe2 = config([rule('dm', 'dm'), rule('sync', 'sync-v2'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe2, recipe1);
    assert.deepStrictEqual(patterns(merged), ['dm-edited', 'zoo-edited', 'sync-edited', null]);
    assert.deepStrictEqual(changes.keptEdited, ['zoo', 'sync']);
    assert.deepStrictEqual(changes.removed, []);
  });

  it("moves a rule whose definition was edited where the recipe's new order puts it, keeping the edit", () => {
    const live = config([rule('dm', 'dm-edited'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);
    const recipe2 = config([rule('sync', 'sync'), rule('zoo', 'zoo'), rule('dm', 'dm'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['sync', 'zoo', 'dm', 'catch-all']);
    assert.deepStrictEqual(merged.policies[2], rule('dm', 'dm-edited'));
    assert.deepStrictEqual(changes.keptEdited, []);
    assert.strictEqual(changes.orderKept, false);
  });

  it('takes a rule that already agrees with the new recipe as the recipe\'s, and names nothing', () => {
    // As after a stop between the two writes: gate.json holds the new recipe's rules, the record the old one.
    const recipe2 = config([rule('dm', 'dm-v2'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll], 'defer');
    const { config: merged, changes } = reconcileWithRecipe(recipe2, recipe2, recipe1);
    assert.deepStrictEqual(merged, recipe2);
    assert.strictEqual(reconcileLine(changes), null);
  });

  it('restores a rule both recipes declare, removed from gate.json since, at its recipe place', () => {
    const live = config([rule('dm', 'dm'), rule('sync', 'sync'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe1, recipe1);
    assert.deepStrictEqual(names(merged), ['dm', 'zoo', 'sync', 'catch-all']);
    assert.deepStrictEqual(changes.restored, ['zoo']);
  });

  it("keeps a run-time move, and names it only when it holds back the recipe's own reorder", () => {
    const moved = config([rule('sync', 'sync'), rule('dm', 'dm'), rule('zoo', 'zoo'), catchAll]);
    const unchanged = reconcileWithRecipe(moved, recipe1, recipe1);
    assert.deepStrictEqual(names(unchanged.config), ['sync', 'dm', 'zoo', 'catch-all']);
    assert.strictEqual(reconcileLine(unchanged.changes), null);
    const reordered = reconcileWithRecipe(moved, config([rule('zoo', 'zoo'), rule('dm', 'dm'), rule('sync', 'sync'), catchAll]), recipe1);
    assert.deepStrictEqual(names(reordered.config), ['sync', 'dm', 'zoo', 'catch-all']);
    assert.strictEqual(reordered.changes.orderKept, true);
    assert.deepStrictEqual(reordered.changes.moved, []);
  });

  it("lets the recipe's reorder through when the rule moved at run time is one the recipe drops", () => {
    const live = config([rule('zoo', 'zoo'), rule('dm', 'dm'), rule('sync', 'sync'), catchAll]);
    const recipe2 = config([rule('sync', 'sync'), rule('dm', 'dm'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['sync', 'dm', 'catch-all']);
    assert.deepStrictEqual(changes.removed, ['zoo']);
    assert.strictEqual(changes.orderKept, false);
  });

  it('puts a rule new to the recipe before the recipe rule that follows it, when gate.json keeps its own order', () => {
    const live = config([rule('sync', 'sync'), rule('dm', 'dm'), rule('zoo', 'zoo'), catchAll]);
    const recipe2 = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), rule('new', 'new'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['sync', 'dm', 'zoo', 'new', 'catch-all']);
    assert.deepStrictEqual(changes.added, ['new']);
  });

  it('puts a rule new to the recipe after the recipe rule before it when none follows, ahead of a run-time rule at the end', () => {
    const live = config([...recipe1.policies, rule('runtime', 'runtime')]);
    const recipe2 = config([...recipe1.policies, rule('tail', 'tail')]);
    const { config: merged } = reconcileWithRecipe(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['dm', 'zoo', 'sync', 'catch-all', 'tail', 'runtime']);
  });

  it("gives an unedited default the recipe's, keeps an edited one, named, and takes one that already agrees", () => {
    const followed = reconcileWithRecipe(recipe1, config(recipe1.policies, 'always'), recipe1);
    assert.strictEqual(followed.config.default, 'always');
    assert.deepStrictEqual(followed.changes.defaultChange, { from: 'skip', to: 'always' });
    const edited = reconcileWithRecipe(config(recipe1.policies, 'defer'), config(recipe1.policies, 'always'), recipe1);
    assert.strictEqual(edited.config.default, 'defer');
    assert.strictEqual(edited.changes.defaultKept, 'defer');
    const agrees = reconcileWithRecipe(config(recipe1.policies, 'always'), config(recipe1.policies, 'always'), recipe1);
    assert.strictEqual(agrees.config.default, 'always');
    assert.strictEqual(reconcileLine(agrees.changes), null);
  });

  it('keeps a run-time rule whose name the recipe now declares otherwise, and names it with the remedy', () => {
    // `watch` was added at run time; the next recipe declares a `watch` of its own.
    const live = config([rule('dm', 'dm'), rule('watch', 'watch-runtime'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);
    const recipe2 = config([rule('dm', 'dm'), rule('watch', 'watch-recipe'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);
    const { config: merged, changes } = reconcileWithRecipe(live, recipe2, recipe1);
    assert.deepStrictEqual(merged.policies[1], rule('watch', 'watch-runtime'));
    assert.deepStrictEqual(changes.differsFromRecipe, ['watch']);
    assert.deepStrictEqual(changes.added, []);
  });

  it('adopts a run-time rule the recipe now declares as it stands, so a later recipe that drops it removes it', () => {
    const live = config([...recipe1.policies.slice(0, 3), rule('watch', 'watch'), catchAll]);
    const recipe2 = config([...recipe1.policies.slice(0, 3), rule('watch', 'watch'), catchAll]);
    const adopted = reconcileWithRecipe(live, recipe2, recipe1);
    assert.deepStrictEqual(adopted.config, live);
    assert.strictEqual(reconcileLine(adopted.changes), null);
    const dropped = reconcileWithRecipe(adopted.config, recipe1, recipe2);
    assert.deepStrictEqual(dropped.changes.removed, ['watch']);
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
    assert.deepStrictEqual(changes.defaultDiffers, { kept: 'skip', recipe: 'always' });
    assert.strictEqual(
      reconcileLine(changes),
      '[gate] the recipe was applied to gate.json: moved agents; '
        + 'kept, though the recipe defines it otherwise: dm (remove such a rule, and the next start restores it from the recipe); '
        + 'kept, not in the recipe: zoo, sync, runtime (a stale one can be removed, and no start brings it back); '
        + "default kept as gate.json has it (skip), though the recipe's is always",
    );
  });

  it('refuses gate.json or a recipe that names a rule twice, since it keys rules by name', () => {
    const twice = config([rule('dm', 'dm'), rule('dm', 'dm-again'), catchAll]);
    assert.throws(() => reconcileWithRecipe(twice, recipe1, recipe1), /gate\.json names the rule "dm" twice/);
    assert.throws(() => reconcileWithRecipe(recipe1, twice, recipe1), /the recipe names the rule "dm" twice/);
  });

  it('says nothing when the recipe and gate.json agree with the last recipe', () => {
    const { config: merged, changes } = reconcileWithRecipe(recipe1, recipe1, recipe1);
    assert.deepStrictEqual(merged, recipe1);
    assert.strictEqual(reconcileLine(changes), null);
  });
});

describe('reconcileLine', () => {
  it('says each kind of change in one line', () => {
    const changes: RecipeChanges = {
      added: ['a'], removed: ['r'], updated: ['u'], restored: ['s'], moved: ['m'],
      keptEdited: ['e'], differsFromRecipe: ['d'], outsideRecipe: ['o'], orderKept: true,
      defaultChange: { from: 'skip', to: 'always' }, recordUnreadable: 'Unexpected token',
    };
    assert.strictEqual(
      reconcileLine(changes),
      "[gate] the recipe was applied to gate.json: the recorded recipe couldn't be read (Unexpected token), so this start removed and redefined nothing; "
        + 'added a; removed r; updated u; restored s; moved m; '
        + 'kept as edited, though the recipe changed or dropped it: e; '
        + 'kept, though the recipe defines it otherwise: d (remove such a rule, and the next start restores it from the recipe); '
        + 'kept, not in the recipe: o (a stale one can be removed, and no start brings it back); '
        + 'default skip → always; '
        + "gate.json's order kept, though the recipe reordered its rules, since a recipe rule was moved in it",
    );
    const kept = reconcileLine({
      added: [], removed: [], updated: [], restored: [], moved: [],
      keptEdited: [], differsFromRecipe: [], outsideRecipe: [], orderKept: false, defaultKept: 'defer',
    });
    assert.strictEqual(kept, '[gate] the recipe was applied to gate.json: default kept as edited (defer), though the recipe changed it');
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
    const logged: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
    console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
    try {
      const gate = new EventGate({
        configPath,
        initialConfig,
        emitTrace: (t) => traces.push(t as { type: string }),
        addMessage: () => '',
        requestInference: () => {},
        getAgentNames: () => ['agent'],
      });
      return { gate, traces, logged };
    } finally {
      console.log = log;
      console.error = error;
    }
  };
  const onDisk = (): GateConfig => JSON.parse(readFileSync(configPath, 'utf-8'));
  const recorded = (): GateConfig => JSON.parse(readFileSync(lastRecipePath(configPath), 'utf-8'));
  const ext = (content: string): GateEventInfo => ({ content, eventType: 'external-message', serverId: 'zulip', channelId: '' });
  const recipe1 = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);
  const recipe2 = config([rule('dm', 'dm-v2', 'defer'), rule('agents', 'sync'), catchAll]);

  it('records the recipe at the first start, and a restart with a new recipe drops, renames and redefines through it', () => {
    start(recipe1).gate.dispose();
    assert.strictEqual(lastRecipePath(configPath), join(dir, '_config', 'gate.recipe.json'));
    assert.deepStrictEqual(recorded(), recipe1);

    const { gate, traces, logged } = start(recipe2);
    try {
      assert.deepStrictEqual(logged, ['[gate] the recipe was applied to gate.json: added agents; removed zoo, sync; updated dm']);
      assert.deepStrictEqual(names(onDisk()), ['dm', 'agents', 'catch-all']);
      assert.deepStrictEqual(onDisk().policies[0], rule('dm', 'dm-v2', 'defer'));
      assert.strictEqual(gate.evaluate(ext('zoo')).policyName, 'catch-all');
      assert.strictEqual(gate.evaluate(ext('sync')).policyName, 'agents');
      assert.deepStrictEqual(gate.lintShadows(), []);
      const trace = traces.find((t) => t.type === 'gate:config-reconciled');
      assert.deepStrictEqual(trace?.removed, ['zoo', 'sync']);
      assert.deepStrictEqual(trace?.added, ['agents']);
      assert.deepStrictEqual(trace?.addedPolicies, ['agents']);
      assert.deepStrictEqual(trace?.updated, ['dm']);
      assert.deepStrictEqual(recorded(), recipe2);
    } finally {
      gate.dispose();
    }
  });

  it('starts on the old appended gate.json with no record: removes nothing, says what differs, and records the recipe', () => {
    // What the old appending left after recipe1 and then recipe2.
    mkdirSync(join(dir, '_config'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config([...recipe1.policies, rule('agents', 'sync')]), null, 2));
    const { gate, logged } = start(recipe2);
    gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['dm', 'zoo', 'sync', 'agents', 'catch-all']);
    assert.deepStrictEqual(onDisk().policies[0], rule('dm', 'dm'));
    assert.strictEqual(logged.length, 1);
    assert.match(logged[0], /moved agents/);
    assert.match(logged[0], /kept, though the recipe defines it otherwise: dm \(remove such a rule/);
    assert.match(logged[0], /kept, not in the recipe: zoo, sync \(a stale one can be removed/);
    assert.deepStrictEqual(recorded(), recipe2);
  });

  it('keeps a recipe rule that wake_add_rule moved, through restarts with the recipe unchanged, and says nothing', () => {
    const first = start(recipe1).gate;
    first.addPolicy(rule('sync', 'sync'), { position: 'prepend' });
    first.dispose();
    for (let i = 0; i < 2; i++) {
      const { gate, logged } = start(recipe1);
      gate.dispose();
      assert.deepStrictEqual(names(onDisk()), ['sync', 'dm', 'zoo', 'catch-all']);
      assert.deepStrictEqual(logged, []);
    }
  });

  it('restores at its recipe place a recipe rule removed at run time, as the clerk recipe tells its resident', () => {
    const first = start(recipe1).gate;
    assert.strictEqual(first.removePolicy('zoo'), true);
    first.dispose();
    const { gate, traces } = start(recipe1);
    gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['dm', 'zoo', 'sync', 'catch-all']);
    const trace = traces.find((t) => t.type === 'gate:config-reconciled');
    assert.deepStrictEqual(trace?.restored, ['zoo']);
    assert.deepStrictEqual(trace?.addedPolicies, ['zoo']);
  });

  it("leaves the next start a state it reads rightly when a stop comes between gate.json's write and the recipe's", () => {
    start(recipe1).gate.dispose();
    const recorded1 = readFileSync(lastRecipePath(configPath), 'utf-8');
    start(recipe2).gate.dispose();
    const afterRestart = readFileSync(configPath, 'utf-8');
    // As if the stop came after gate.json was written and before the recipe was.
    writeFileSync(lastRecipePath(configPath), recorded1);
    const { gate, traces } = start(recipe2);
    gate.dispose();
    assert.strictEqual(readFileSync(configPath, 'utf-8'), afterRestart);
    assert.deepStrictEqual(recorded(), recipe2);
    assert.strictEqual(traces.some((t) => t.type === 'gate:config-reconciled'), false);
  });

  it('records the new recipe only after gate.json is written, so a failed write leaves the next start to merge again, and says why', () => {
    start(recipe1).gate.dispose();
    const recorded1 = readFileSync(lastRecipePath(configPath), 'utf-8');
    // gate.json's write goes through a staging file beside it: a directory
    // in its place makes that write fail, as a full disk would.
    const blocker = `${configPath}.${process.pid}~`;
    mkdirSync(blocker);
    const failed = start(recipe2);
    failed.gate.dispose();
    assert.deepStrictEqual(names(onDisk()), names(recipe1));
    assert.strictEqual(readFileSync(lastRecipePath(configPath), 'utf-8'), recorded1);
    assert.match(failed.gate.getStatus().errors.join('\n'), /Failed to seed\/reconcile gate\.json: /);
    assert.ok(failed.traces.some((t) => t.type === 'gate:config-error'));
    assert.match(failed.logged.join('\n'), /\[gate\] Failed to seed\/reconcile gate\.json: /);
    rmSync(blocker, { recursive: true });
    start(recipe2).gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['dm', 'agents', 'catch-all']);
    assert.deepStrictEqual(onDisk().policies[0], rule('dm', 'dm-v2', 'defer'));
  });

  it('removes the staging file a failed write leaves, and says why', () => {
    start(recipe1).gate.dispose();
    // A directory where the record goes: its staging file is written, and the rename over it fails.
    rmSync(lastRecipePath(configPath));
    mkdirSync(lastRecipePath(configPath));
    const { gate } = start(recipe2);
    gate.dispose();
    assert.strictEqual(existsSync(`${lastRecipePath(configPath)}.${process.pid}~`), false);
    assert.match(gate.getStatus().errors.join('\n'), /Failed to seed\/reconcile gate\.json: /);
  });

  it('says when the record does not read, and then removes and redefines nothing', () => {
    start(recipe1).gate.dispose();
    writeFileSync(lastRecipePath(configPath), '{ "policies": [ damaged');
    const { gate, logged } = start(recipe2);
    gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['dm', 'zoo', 'sync', 'agents', 'catch-all']);
    assert.match(logged.join('\n'), /the recorded recipe couldn't be read \(.+\), so this start removed and redefined nothing/);
    assert.deepStrictEqual(recorded(), recipe2);
  });

  it('reads a record that names a rule twice as one that does not read', () => {
    start(recipe1).gate.dispose();
    writeFileSync(lastRecipePath(configPath), JSON.stringify(config([...recipe1.policies, rule('dm', 'dm-again')])));
    const { gate, logged } = start(recipe2);
    gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['dm', 'zoo', 'sync', 'agents', 'catch-all']);
    assert.match(logged.join('\n'), /the recorded recipe couldn't be read \(it names the rule "dm" twice\)/);
  });

  it('leaves gate.json that names a rule twice as it is, records nothing new, and says why', () => {
    start(recipe1).gate.dispose();
    const recorded1 = readFileSync(lastRecipePath(configPath), 'utf-8');
    const twice = JSON.stringify(config([rule('dm', 'dm'), rule('dm', 'dm-again'), catchAll]), null, 2);
    writeFileSync(configPath, twice);
    const { gate } = start(recipe2);
    gate.dispose();
    assert.strictEqual(readFileSync(configPath, 'utf-8'), twice);
    assert.strictEqual(readFileSync(lastRecipePath(configPath), 'utf-8'), recorded1);
    assert.match(gate.getStatus().errors.join('\n'), /gate\.json names the rule "dm" twice/);
  });

  it("leaves gate.json's bytes as written when a start changes nothing", () => {
    start(recipe1).gate.dispose();
    const compact = JSON.stringify(onDisk());
    writeFileSync(configPath, compact);
    start(recipe1).gate.dispose();
    assert.strictEqual(readFileSync(configPath, 'utf-8'), compact);
  });

  it('writes a symlinked gate.json at its target, keeping the link and the mode', () => {
    mkdirSync(join(dir, '_config'), { recursive: true });
    const target = join(dir, 'kept-elsewhere.json');
    writeFileSync(target, JSON.stringify(recipe1, null, 2));
    chmodSync(target, 0o640);
    symlinkSync(target, configPath);
    writeFileSync(lastRecipePath(configPath), JSON.stringify(recipe1, null, 2));
    start(recipe2).gate.dispose();
    assert.ok(lstatSync(configPath).isSymbolicLink());
    assert.deepStrictEqual(names(JSON.parse(readFileSync(target, 'utf-8'))), ['dm', 'agents', 'catch-all']);
    assert.strictEqual(statSync(target).mode & 0o777, 0o640);
  });

  it("leaves a gate.json that doesn't load as it is, and records no recipe", () => {
    mkdirSync(join(dir, '_config'), { recursive: true });
    writeFileSync(configPath, '{ "policies": [ not json');
    start(recipe1).gate.dispose();
    assert.strictEqual(readFileSync(configPath, 'utf-8'), '{ "policies": [ not json');
    assert.strictEqual(existsSync(lastRecipePath(configPath)), false);
  });

  it('runs every probe event, and names the rules none reaches, such as one scoped to external-message', () => {
    const gate = start(config([
      { name: 'zulip-addressed', match: { scope: ['external-message'], metadataTrue: ['isMention'] }, behavior: 'always' },
      { name: 'notes-mount', match: { mount: 'notes' }, behavior: 'always' },
      { name: 'mentions', match: { metadataTrue: ['isMention'] }, behavior: 'always' },
    ])).gate;
    try {
      assert.deepStrictEqual(gate.probeUnreached(), ['zulip-addressed', 'notes-mount']);
      assert.deepStrictEqual(gate.probeTable().map((row) => row.probe), [
        'dm (open channel)', 'dm (closed channel)',
        'explicit mention (open channel)', 'explicit mention (closed channel)',
        'reply to you', 'ambient (human)', 'ambient (bot)', 'heartbeat',
      ]);
    } finally {
      gate.dispose();
    }
  });
});

describe("wake_add_rule's result", () => {
  it("names a rule no probe event reaches, so its rows of default:skip don't read as its effect, and keeps the plain note for one that changes nothing", async () => {
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
      type Data = { notProbed?: string[]; notProbedNote?: string; note?: string; probes: Array<{ wouldWake: boolean }> };
      const add = (id: string, input: unknown): Data => {
        internals.dispatchWakeRuleToolCall('prime', { id, name: 'wake_add_rule', input });
        const result = pushed.filter((e) => e.type === 'tool-result').pop()?.result;
        assert.ok(result?.success, JSON.stringify(pushed));
        return result!.data as Data;
      };

      const unreached = add('add-1', { name: 'zulip-addressed', match: { scope: ['external-message'], metadataTrue: ['isMention'] }, behavior: 'always' });
      assert.deepStrictEqual(unreached.notProbed, ['zulip-addressed']);
      assert.match(unreached.notProbedNote ?? '', /^No probe event matches these rules/);
      assert.ok(unreached.probes.every((p) => !p.wouldWake));
      assert.match(unreached.note ?? '', /the new rule matches no probe event \(see notProbed\)/);

      add('add-2', { name: 'wake-all', match: {}, behavior: 'always' });
      // Behind wake-all, a rule every probe reaches changes no winner.
      const shadowed = add('add-3', { name: 'also-all', match: {}, behavior: 'skip' });
      assert.deepStrictEqual(shadowed.notProbed, ['zulip-addressed']);
      assert.strictEqual(shadowed.note, 'No canonical probe changed its winning rule — the new rule affects none of the common chat/heartbeat shapes.');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
