/**
 * What a start does to an existing gate.json given the recipe (agent-framework #654):
 * the three-way merge against the recipe last applied, as a pure function and
 * through EventGate's files, and the wake_add_rule result's word on rules no
 * probe event reaches.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
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
/** The merge on configs as written, given and returned as GateConfigs. */
const reconcile = (live: GateConfig, recipe: GateConfig, last: GateConfig | null): { config: GateConfig; changes: RecipeChanges } => {
  const written = (c: GateConfig) => ({ rules: c.policies, default: c.default });
  const merged = reconcileWithRecipe(written(live), written(recipe), last ? written(last) : null);
  return { config: { ...live, policies: merged.rules as GatePolicy[], default: merged.default as GateConfig['default'] }, changes: merged.changes };
};
const patterns = (c: GateConfig): Array<string | null> => c.policies.map((p) => p.match.filter?.pattern ?? null);

describe('reconcileWithRecipe: a start against the recipe last applied', () => {
  const recipe1 = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);

  it('drops a rule the recipe dropped, and brings a renamed one in at its recipe place, ahead of the catch-all', () => {
    const recipe2 = config([rule('dm', 'dm'), rule('agents', 'sync'), catchAll]);
    const { config: merged, changes } = reconcile(recipe1, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['dm', 'agents', 'catch-all']);
    assert.deepStrictEqual(changes.removed, ['zoo', 'sync']);
    assert.deepStrictEqual(changes.added, ['agents']);
  });

  it("gives an unedited rule the recipe's new definition and order, and keeps a run-time rule in its place", () => {
    const live = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), rule('runtime', 'runtime'), catchAll]);
    const recipe2 = config([rule('sync', 'sync'), rule('dm', 'dm-v2', 'defer'), rule('zoo', 'zoo'), catchAll]);
    const { config: merged, changes } = reconcile(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['sync', 'dm', 'zoo', 'runtime', 'catch-all']);
    assert.deepStrictEqual(merged.policies[1], rule('dm', 'dm-v2', 'defer'));
    assert.deepStrictEqual(changes.updated, ['dm']);
    assert.deepStrictEqual(changes.moved, ['sync']);
    assert.strictEqual(changes.orderKept, false);
  });

  it('keeps a rule edited since the last recipe, and names it when the recipe changed or dropped it', () => {
    const live = config([rule('dm', 'dm-edited'), rule('zoo', 'zoo-edited'), rule('sync', 'sync-edited'), catchAll]);
    const recipe2 = config([rule('dm', 'dm'), rule('sync', 'sync-v2'), catchAll]);
    const { config: merged, changes } = reconcile(live, recipe2, recipe1);
    assert.deepStrictEqual(patterns(merged), ['dm-edited', 'zoo-edited', 'sync-edited', null]);
    assert.deepStrictEqual(changes.keptEdited, ['zoo', 'sync']);
    assert.deepStrictEqual(changes.removed, []);
  });

  it("moves a rule whose definition was edited where the recipe's new order puts it, keeping the edit", () => {
    const live = config([rule('dm', 'dm-edited'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);
    const recipe2 = config([rule('sync', 'sync'), rule('zoo', 'zoo'), rule('dm', 'dm'), catchAll]);
    const { config: merged, changes } = reconcile(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['sync', 'zoo', 'dm', 'catch-all']);
    assert.deepStrictEqual(merged.policies[2], rule('dm', 'dm-edited'));
    assert.deepStrictEqual(changes.keptEdited, []);
    assert.strictEqual(changes.orderKept, false);
  });

  it('takes a rule that already agrees with the new recipe as the recipe\'s, and names nothing', () => {
    // As after a stop between the two writes: gate.json holds the new recipe's rules, the record the old one.
    const recipe2 = config([rule('zoo', 'zoo'), rule('dm', 'dm-v2'), rule('sync', 'sync'), catchAll], 'defer');
    const { config: merged, changes } = reconcile(recipe2, recipe2, recipe1);
    assert.deepStrictEqual(merged, recipe2);
    assert.strictEqual(reconcileLine(changes), null);
  });

  it('names as moved the recipe rule a reorder brought earlier, and never a run-time rule left in place', () => {
    const live = config([rule('dm', 'dm'), rule('runtime', 'runtime'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);
    const recipe2 = config([rule('zoo', 'zoo'), rule('dm', 'dm'), rule('sync', 'sync'), catchAll]);
    const { config: merged, changes } = reconcile(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['zoo', 'runtime', 'dm', 'sync', 'catch-all']);
    assert.deepStrictEqual(changes.moved, ['zoo']);
  });

  it('restores a rule both recipes declare, removed from gate.json since, at its recipe place', () => {
    const live = config([rule('dm', 'dm'), rule('sync', 'sync'), catchAll]);
    const { config: merged, changes } = reconcile(live, recipe1, recipe1);
    assert.deepStrictEqual(names(merged), ['dm', 'zoo', 'sync', 'catch-all']);
    assert.deepStrictEqual(changes.restored, ['zoo']);
    // The removed rule isn't counted as moved, so the recipe's reorder still comes through.
    const reordered = reconcile(live, config([rule('sync', 'sync'), rule('zoo', 'zoo'), rule('dm', 'dm'), catchAll]), recipe1);
    assert.deepStrictEqual(names(reordered.config), ['sync', 'zoo', 'dm', 'catch-all']);
    assert.strictEqual(reordered.changes.orderKept, false);
    assert.deepStrictEqual(reordered.changes.moved, ['sync']);
    assert.deepStrictEqual(reordered.changes.restored, ['zoo']);
  });

  it("appends in the recipe's order the rules it brings when none of its rules is left to place them by", () => {
    const live = config([rule('runtime', 'runtime')]);
    const { config: merged, changes } = reconcile(live, recipe1, recipe1);
    assert.deepStrictEqual(names(merged), ['runtime', 'dm', 'zoo', 'sync', 'catch-all']);
    assert.deepStrictEqual(changes.restored, ['dm', 'zoo', 'sync', 'catch-all']);
  });

  it("keeps a run-time move, and names it only when it holds back the recipe's own reorder", () => {
    const moved = config([rule('sync', 'sync'), rule('dm', 'dm'), rule('zoo', 'zoo'), catchAll]);
    const unchanged = reconcile(moved, recipe1, recipe1);
    assert.deepStrictEqual(names(unchanged.config), ['sync', 'dm', 'zoo', 'catch-all']);
    assert.strictEqual(reconcileLine(unchanged.changes), null);
    const reordered = reconcile(moved, config([rule('zoo', 'zoo'), rule('dm', 'dm'), rule('sync', 'sync'), catchAll]), recipe1);
    assert.deepStrictEqual(names(reordered.config), ['sync', 'dm', 'zoo', 'catch-all']);
    assert.strictEqual(reordered.changes.orderKept, true);
    assert.deepStrictEqual(reordered.changes.moved, []);
  });

  it("lets the recipe's reorder through when the rule moved at run time is one the recipe drops", () => {
    const live = config([rule('zoo', 'zoo'), rule('dm', 'dm'), rule('sync', 'sync'), catchAll]);
    const recipe2 = config([rule('sync', 'sync'), rule('dm', 'dm'), catchAll]);
    const { config: merged, changes } = reconcile(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['sync', 'dm', 'catch-all']);
    assert.deepStrictEqual(changes.removed, ['zoo']);
    assert.strictEqual(changes.orderKept, false);
  });

  it('puts a rule new to the recipe before the recipe rule that follows it, when gate.json keeps its own order', () => {
    const live = config([rule('sync', 'sync'), rule('dm', 'dm'), rule('zoo', 'zoo'), catchAll]);
    const recipe2 = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), rule('new', 'new'), catchAll]);
    const { config: merged, changes } = reconcile(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['sync', 'dm', 'zoo', 'new', 'catch-all']);
    assert.deepStrictEqual(changes.added, ['new']);
  });

  it('puts a rule new to the recipe after the recipe rule before it when none follows, ahead of a run-time rule at the end', () => {
    const live = config([...recipe1.policies, rule('runtime', 'runtime')]);
    const recipe2 = config([...recipe1.policies, rule('tail', 'tail')]);
    const { config: merged } = reconcile(live, recipe2, recipe1);
    assert.deepStrictEqual(names(merged), ['dm', 'zoo', 'sync', 'catch-all', 'tail', 'runtime']);
  });

  it("gives an unedited default the recipe's, keeps an edited one, named, and takes one that already agrees", () => {
    const followed = reconcile(recipe1, config(recipe1.policies, 'always'), recipe1);
    assert.strictEqual(followed.config.default, 'always');
    assert.deepStrictEqual(followed.changes.defaultChange, { from: 'skip', to: 'always' });
    const edited = reconcile(config(recipe1.policies, 'defer'), config(recipe1.policies, 'always'), recipe1);
    assert.strictEqual(edited.config.default, 'defer');
    assert.strictEqual(edited.changes.defaultKept, 'defer');
    const unchangedRecipe = reconcile(config(recipe1.policies, 'defer'), recipe1, recipe1);
    assert.strictEqual(unchangedRecipe.config.default, 'defer');
    assert.strictEqual(unchangedRecipe.changes.defaultKept, undefined);
    const agrees = reconcile(config(recipe1.policies, 'always'), config(recipe1.policies, 'always'), recipe1);
    assert.strictEqual(agrees.config.default, 'always');
    assert.strictEqual(reconcileLine(agrees.changes), null);
  });

  it('keeps a run-time rule whose name the recipe now declares otherwise, and names it with the remedy', () => {
    // `watch` was added at run time; the next recipe declares a `watch` of its own.
    const live = config([rule('dm', 'dm'), rule('watch', 'watch-runtime'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);
    const recipe2 = config([rule('dm', 'dm'), rule('watch', 'watch-recipe'), rule('zoo', 'zoo'), rule('sync', 'sync'), catchAll]);
    const { config: merged, changes } = reconcile(live, recipe2, recipe1);
    assert.deepStrictEqual(merged.policies[1], rule('watch', 'watch-runtime'));
    assert.deepStrictEqual(changes.differsFromRecipe, ['watch']);
    assert.deepStrictEqual(changes.added, []);
  });

  it('adopts a run-time rule the recipe now declares as it stands, so a later recipe that drops it removes it', () => {
    const live = config([...recipe1.policies.slice(0, 3), rule('watch', 'watch'), catchAll]);
    const recipe2 = config([...recipe1.policies.slice(0, 3), rule('watch', 'watch'), catchAll]);
    const adopted = reconcile(live, recipe2, recipe1);
    assert.deepStrictEqual(adopted.config, live);
    assert.strictEqual(reconcileLine(adopted.changes), null);
    const dropped = reconcile(adopted.config, recipe1, recipe2);
    assert.deepStrictEqual(dropped.changes.removed, ['watch']);
  });

  it('without a last recipe, removes and redefines nothing: rules that match the recipe take its order, and the rest are named', () => {
    // What the old appending left: a rule the recipe dropped, one it redefined,
    // and the recipe's renamed rule behind the catch-all.
    const live = config([rule('dm', 'dm'), rule('zoo', 'zoo'), rule('sync', 'sync'), rule('runtime', 'runtime'), catchAll, rule('agents', 'agents')]);
    const recipe2 = config([rule('dm', 'dm-v2'), rule('agents', 'agents'), catchAll], 'always');
    const { config: merged, changes } = reconcile(live, recipe2, null);
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
      '[gate] the recipe was applied to gate.json: moved "agents"; '
        + 'kept, though the recipe defines it otherwise: "dm" (remove such a rule, and the next start restores it from the recipe); '
        + 'kept, not in the recipe: "zoo", "sync", "runtime" (a stale one can be removed, and no start brings it back); '
        + "default kept as gate.json has it (skip), though the recipe's is always (set it to the recipe's, and later starts follow the recipe)",
    );
    const sameDefault = reconcile(live, config(recipe2.policies, 'skip'), null);
    assert.strictEqual(sameDefault.changes.defaultDiffers, undefined);
  });

  it('keeps a rule with no name where gate.json holds it, and never merges a recipe rule with no name', () => {
    const nameless = { match: { scope: ['external-message'] }, behavior: 'skip' } as unknown as GatePolicy;
    const live = config([rule('dm', 'dm'), nameless, rule('zoo', 'zoo'), catchAll]);
    const merged = reconcileWithRecipe(
      { rules: live.policies, default: live.default },
      { rules: [rule('dm', 'dm-v2'), nameless, catchAll], default: 'skip' },
      { rules: recipe1.policies, default: 'skip' },
    );
    // "zoo" goes and "dm" is redefined; the nameless rule stays second, and the recipe's isn't added.
    assert.deepStrictEqual(merged.rules, [rule('dm', 'dm-v2'), nameless, catchAll]);
    assert.deepStrictEqual(merged.changes.removed, ['zoo']);
    assert.deepStrictEqual(merged.changes.updated, ['dm']);
    assert.deepStrictEqual(merged.changes.added, []);
    // Without a last recipe, the nameless rule isn't named as outside the recipe.
    const first = reconcileWithRecipe({ rules: live.policies, default: live.default }, { rules: [nameless], default: 'skip' }, null);
    assert.deepStrictEqual(first.changes.outsideRecipe, ['dm', 'zoo', 'catch-all']);
    assert.strictEqual(first.rules.length, 4);
  });

  it('reads a default left out, null or "" as "always", so none of them reads as an edit of the others', () => {
    const at = (value: unknown) => ({ rules: recipe1.policies, default: value });
    for (const live of [undefined, null, '']) {
      const merged = reconcileWithRecipe(at(live), at('skip'), at('always'));
      assert.strictEqual(merged.default, 'skip', `live default ${JSON.stringify(live)}`);
      assert.deepStrictEqual(merged.changes.defaultChange, { from: 'always', to: 'skip' });
    }
  });

  it("compares a rule with an own \"__proto__\" field as written, that field included", () => {
    const withField = (value: number) => JSON.parse(`{"name": "odd", "behavior": ["skip"], "__proto__": {"n": ${value}}}`) as GatePolicy;
    const merged = reconcileWithRecipe(
      { rules: [withField(2)], default: 'skip' }, { rules: [rule('odd', 'odd')], default: 'skip' }, { rules: [withField(1)], default: 'skip' },
    );
    assert.deepStrictEqual(merged.changes.keptEdited, ['odd']);
  });

  it('refuses gate.json or a recipe that names a rule twice, since it keys rules by name', () => {
    const twice = config([rule('dm', 'dm'), rule('dm', 'dm-again'), catchAll]);
    assert.throws(() => reconcile(twice, recipe1, recipe1), /^Error: gate\.json names the rule "dm" twice$/);
    assert.throws(() => reconcile(recipe1, twice, recipe1), /^Error: the recipe names the rule "dm" twice$/);
  });

  it("reads a rule whose keys come in another order as the same rule", () => {
    const reordered = config(recipe1.policies.map((p) => JSON.parse(JSON.stringify({ behavior: p.behavior, name: p.name, match: p.match })) as GatePolicy));
    const { changes } = reconcile(reordered, recipe1, recipe1);
    assert.strictEqual(reconcileLine(changes), null);
  });

  it('says nothing when the recipe and gate.json agree with the last recipe', () => {
    const { config: merged, changes } = reconcile(recipe1, recipe1, recipe1);
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
        + 'added "a"; removed "r"; updated "u"; restored "s"; moved "m"; '
        + 'kept as edited, though the recipe changed or dropped it: "e"; '
        + 'kept, though the recipe defines it otherwise: "d" (remove such a rule, and the next start restores it from the recipe); '
        + 'kept, not in the recipe: "o" (a stale one can be removed, and no start brings it back); '
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
    // What went to stdout, apart: the gate's lines go to stderr.
    const stdout: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => { logged.push(args.join(' ')); stdout.push(args.join(' ')); };
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
      return { gate, traces, logged, stdout };
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

    const { gate, traces, logged, stdout } = start(recipe2);
    try {
      assert.deepStrictEqual(logged, ['[gate] the recipe was applied to gate.json: added "agents"; removed "zoo", "sync"; updated "dm"']);
      assert.deepStrictEqual(stdout, [], 'the line goes to stderr');
      assert.deepStrictEqual(names(onDisk()), ['dm', 'agents', 'catch-all']);
      assert.deepStrictEqual(onDisk().policies[0], rule('dm', 'dm-v2', 'defer'));
      assert.strictEqual(gate.evaluate(ext('zoo')).policyName, 'catch-all');
      assert.strictEqual(gate.evaluate(ext('sync')).policyName, 'agents');
      assert.deepStrictEqual(gate.lintShadows(), []);
      const trace = traces.find((t) => t.type === 'gate:config-reconciled');
      assert.deepStrictEqual(trace?.removed, ['zoo', 'sync']);
      assert.deepStrictEqual(trace?.added, ['agents']);
      assert.deepStrictEqual(trace?.updated, ['dm']);
      assert.deepStrictEqual(recorded(), recipe2);
    } finally {
      gate.dispose();
    }
  });

  it('merges against a record saved with a BOM, as gate.json is read', () => {
    start(recipe1).gate.dispose();
    writeFileSync(lastRecipePath(configPath), '\uFEFF' + JSON.stringify(recorded(), null, 2));
    const { gate, logged } = start(recipe2);
    try {
      assert.deepStrictEqual(logged, ['[gate] the recipe was applied to gate.json: added "agents"; removed "zoo", "sync"; updated "dm"']);
      assert.deepStrictEqual(names(onDisk()), ['dm', 'agents', 'catch-all']);
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
    assert.match(logged[0], /moved "agents"/);
    assert.match(logged[0], /kept, though the recipe defines it otherwise: "dm" \(remove such a rule/);
    assert.match(logged[0], /kept, not in the recipe: "zoo", "sync" \(a stale one can be removed/);
    assert.doesNotMatch(logged[0], /couldn't be read/);
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

  it('writes gate.json before the record, and names what it changed when the record then fails to write', () => {
    start(recipe1).gate.dispose();
    // A directory where the record goes: it doesn't read, and writing it fails.
    rmSync(lastRecipePath(configPath));
    mkdirSync(lastRecipePath(configPath));
    const { gate, traces, logged } = start(recipe2);
    gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['dm', 'zoo', 'sync', 'agents', 'catch-all']);
    assert.match(logged[0], /^\[gate\] the recipe was applied to gate\.json: the recorded recipe couldn't be read \(reading it failed with EISDIR\), so this start removed and redefined nothing; added "agents"/);
    assert.ok(traces.some((t) => t.type === 'gate:config-reconciled'));
    const errors = gate.getStatus().errors;
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /^At start, gate\.json holds the recipe merged into it, and the gate runs it, but recording the recipe in gate\.recipe\.json failed \(.*EISDIR.*\), so the next start merges against the record as this write left it\. Whoever runs this host can fix what kept it from being written\.$/);
    assert.ok(logged.includes(`[gate] ${errors[0]}`), JSON.stringify(logged));
  });

  it('says nothing was done to gate.json when only recording the recipe fails', () => {
    mkdirSync(join(dir, '_config'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(recipe2, null, 2));
    mkdirSync(lastRecipePath(configPath));
    const before = readFileSync(configPath, 'utf-8');
    const { gate } = start(recipe2);
    gate.dispose();
    assert.strictEqual(readFileSync(configPath, 'utf-8'), before);
    assert.match(gate.getStatus().errors[0], /^At start, the merge left gate\.json as it was, and the gate runs it, but recording the recipe in gate\.recipe\.json failed /);
  });

  it('says gate.json was seeded when recording the recipe then fails at the first start', () => {
    mkdirSync(join(dir, '_config'), { recursive: true });
    mkdirSync(lastRecipePath(configPath));
    const { gate } = start(recipe1);
    gate.dispose();
    assert.deepStrictEqual(onDisk(), recipe1);
    assert.match(gate.getStatus().errors[0], /^At start, gate\.json was seeded with the recipe, and the gate runs it, but recording the recipe in gate\.recipe\.json failed /);
  });

  it('says when the record does not read, and then removes and redefines nothing', () => {
    start(recipe1).gate.dispose();
    writeFileSync(lastRecipePath(configPath), '{ "policies": [ damaged');
    const { gate, logged } = start(recipe2);
    gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['dm', 'zoo', 'sync', 'agents', 'catch-all']);
    assert.match(logged.join('\n'), /the recorded recipe couldn't be read \(it isn't JSON\), so this start removed and redefined nothing/);
    assert.deepStrictEqual(recorded(), recipe2);
  });

  it('reads a record refused as the starting rules are refused as one that does not read', () => {
    start(recipe1).gate.dispose();
    writeFileSync(lastRecipePath(configPath), JSON.stringify({ policies: recipe1.policies, default: 'sometimes' }));
    const { gate, logged } = start(recipe2);
    gate.dispose();
    assert.match(logged.join('\n'), /the recorded recipe couldn't be read \(it isn't read as the starting rules are\)/);
  });

  it('reads back a recipe recorded with no list of policies, so its default follows the next recipe', () => {
    // A recipe of a default alone is read with no rules, recorded as given, and read back the same way.
    start({ default: 'skip' } as unknown as GateConfig).gate.dispose();
    assert.deepStrictEqual(recorded(), { default: 'skip' });
    const { gate, logged } = start({ default: 'always' } as unknown as GateConfig);
    gate.dispose();
    assert.strictEqual(onDisk().default, 'always');
    assert.deepStrictEqual(logged, ['[gate] the recipe was applied to gate.json: default skip → always']);
  });

  it('reads a record of JSON null as one that does not read', () => {
    start(recipe1).gate.dispose();
    writeFileSync(lastRecipePath(configPath), 'null');
    const { gate, logged } = start(recipe2);
    gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['dm', 'zoo', 'sync', 'agents', 'catch-all']);
    assert.match(logged.join('\n'), /the recorded recipe couldn't be read \(it isn't read as the starting rules are\)/);
  });

  it('reads a record that names a rule twice as one that does not read', () => {
    start(recipe1).gate.dispose();
    writeFileSync(lastRecipePath(configPath), JSON.stringify(config([...recipe1.policies, rule('dm', 'dm-again')])));
    const { gate, logged } = start(recipe2);
    gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['dm', 'zoo', 'sync', 'agents', 'catch-all']);
    assert.match(logged.join('\n'), /the recorded recipe couldn't be read \(it names the rule "dm" twice\)/);
  });

  it('only adds the rules gate.json lacks when it names a rule twice, records nothing new, and says why', () => {
    start(recipe1).gate.dispose();
    const recorded1 = readFileSync(lastRecipePath(configPath), 'utf-8');
    const twice = config([rule('dm', 'dm'), rule('dm', 'dm-again'), catchAll]);
    writeFileSync(configPath, JSON.stringify(twice, null, 2));
    const { gate, traces, logged } = start(recipe2);
    gate.dispose();
    // As an append did: gate.json's own rules as they were, then the recipe's that it lacked.
    assert.deepStrictEqual(onDisk().policies, [...twice.policies, rule('agents', 'sync')]);
    assert.strictEqual(readFileSync(lastRecipePath(configPath), 'utf-8'), recorded1);
    const said = 'At start, gate.json names the rule "dm" twice, and the merge with the recipe needs one rule per name, so it didn\'t '
      + 'run: the start added the rules gate.json lacked ("agents"), after its own, and removed, redefined and recorded nothing. '
      + 'Once gate.json and the recipe name each rule once, a start merges the recipe.';
    assert.ok(gate.getStatus().errors.includes(said), JSON.stringify(gate.getStatus().errors));
    assert.ok(logged.includes(`[gate] ${said}`), JSON.stringify(logged));
    assert.ok(!logged.some((line) => line.startsWith('[gate] the recipe was applied')), JSON.stringify(logged));
    assert.deepStrictEqual(traces.filter((t) => t.type === 'gate:config-reconciled').map((t) => t.addedPolicies), [['agents']]);
    // A run-time edit loads and writes gate.json, and the start's word stays in status.
    gate.addPolicy(rule('watch', 'watch'));
    assert.ok(gate.getStatus().errors.includes(said));
  });

  it('leaves gate.json that names a rule twice as it is when it lacks none of the recipe\'s rules, and says so', () => {
    start(recipe1).gate.dispose();
    const twice = JSON.stringify(config([rule('dm', 'dm'), rule('dm', 'dm-again'), catchAll]), null, 2);
    writeFileSync(configPath, twice);
    const { gate } = start(config([rule('dm', 'dm-v2'), catchAll]));
    gate.dispose();
    assert.strictEqual(readFileSync(configPath, 'utf-8'), twice);
    assert.ok(gate.getStatus().errors.includes(
      'At start, gate.json names the rule "dm" twice, and the merge with the recipe needs one rule per name, so it didn\'t run: '
        + 'gate.json is as it was, and nothing was recorded. Once gate.json and the recipe name each rule once, a start merges the recipe.',
    ), JSON.stringify(gate.getStatus().errors));
  });

  it('only adds the rules gate.json lacks at a later start whose recipe names a rule twice, and records nothing', () => {
    start(recipe1).gate.dispose();
    const recorded1 = readFileSync(lastRecipePath(configPath), 'utf-8');
    const { gate } = start(config([rule('dm', 'dm-v2'), rule('dm', 'dm-again'), rule('new', 'new'), catchAll]));
    gate.dispose();
    // "zoo" and "sync" stay and "dm" keeps its definition: only "new" is added, after gate.json's own.
    assert.deepStrictEqual(onDisk().policies, [...recipe1.policies, rule('new', 'new')]);
    assert.strictEqual(readFileSync(lastRecipePath(configPath), 'utf-8'), recorded1);
    assert.match(gate.getStatus().errors.join('\n'), /At start, the recipe names the rule "dm" twice, and the merge with the recipe needs one rule per name, so it didn't run: the start added the rules gate\.json lacked \("new"\)/);
  });

  it('compares rules by meaning, so a recipe rule wake_add_rule wrote back as the gate reads it still follows the recipe', () => {
    // A recipe that leaves "behavior" out, which the gate reads as "always".
    const brief = (name: string, pattern: string) => ({ name, match: rule(name, pattern).match }) as GatePolicy;
    const recipeA = config([brief('dm', 'dm'), brief('zoo', 'zoo'), catchAll]);
    const first = start(recipeA).gate;
    // Re-issuing "dm" unchanged writes it as the gate reads it, "behavior" included.
    first.addPolicy(brief('dm', 'dm'));
    first.dispose();
    assert.deepStrictEqual(onDisk().policies[0], rule('dm', 'dm'));
    // gate.json's rule agrees with the recipe's, so a start keeps it as written and says nothing of it.
    const again = start(recipeA);
    again.gate.dispose();
    assert.deepStrictEqual(onDisk().policies[0], rule('dm', 'dm'));
    assert.deepStrictEqual(again.logged, []);
    // A recipe that redefines it is followed, not kept as an edit nobody made.
    const recipeB = config([rule('dm', 'dm-v2', 'defer'), brief('zoo', 'zoo'), catchAll]);
    const { gate, logged } = start(recipeB);
    gate.dispose();
    assert.deepStrictEqual(onDisk().policies[0], rule('dm', 'dm-v2', 'defer'));
    assert.deepStrictEqual(logged, ['[gate] the recipe was applied to gate.json: updated "dm"']);
  });

  it("doesn't count a change to a field the gate doesn't read as an edit, so a recipe change replaces it", () => {
    start(recipe1).gate.dispose();
    const noted = { ...rule('zoo', 'zoo'), note: 'kept by hand' };
    writeFileSync(configPath, JSON.stringify({ ...recipe1, policies: [recipe1.policies[0], noted, ...recipe1.policies.slice(2)] }, null, 2));
    // Unchanged, the recipe leaves the rule as written.
    start(recipe1).gate.dispose();
    assert.deepStrictEqual(onDisk().policies[1], noted);
    // Changed, the recipe's rule takes its place as written.
    const { gate, logged } = start(config([rule('dm', 'dm'), rule('zoo', 'zoo-v2'), rule('sync', 'sync'), catchAll]));
    gate.dispose();
    assert.deepStrictEqual(onDisk().policies[1], rule('zoo', 'zoo-v2'));
    assert.match(logged.join('\n'), /updated "zoo"/);
  });

  it("names the merge's changes a write that fails at its open didn't save, with gate.json's rules in force as they were", (t) => {
    start(recipe1).gate.dispose();
    const before = readFileSync(configPath, 'utf-8');
    const original = fs.writeFileSync;
    const write = t.mock.method(fs, 'writeFileSync', (path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      if (path !== configPath) return original(path, data, ...(rest as []));
      throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES', syscall: 'open' });
    });
    syncBuiltinESMExports();
    let started: ReturnType<typeof start>;
    try {
      started = start(recipe2);
    } finally {
      write.mock.restore();
      syncBuiltinESMExports();
    }
    const { gate } = started;
    gate.dispose();
    assert.strictEqual(readFileSync(configPath, 'utf-8'), before);
    assert.deepStrictEqual(gate.getStatus().policies.map((p) => p.name), names(recipe1));
    assert.deepStrictEqual(recorded(), recipe1, 'nothing recorded');
    const errors = gate.getStatus().errors.join('\n');
    assert.match(errors, /At start, the host's starting rules "agents" couldn't be added to gate\.json \(EACCES: permission denied, open\)/);
    assert.match(errors, /At start, the recipe's changes to gate\.json \("zoo", "sync" and "dm"\) weren't saved \(EACCES: permission denied, open\), so the gate started with gate\.json's rules as they were\. Whoever runs this host can fix what kept them from being written\./);
  });

  it("names a default change that a write failing at its open didn't save", (t) => {
    start(recipe1).gate.dispose();
    const original = fs.writeFileSync;
    const write = t.mock.method(fs, 'writeFileSync', (path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      if (path !== configPath) return original(path, data, ...(rest as []));
      throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES', syscall: 'open' });
    });
    syncBuiltinESMExports();
    let started: ReturnType<typeof start>;
    try {
      started = start(config(recipe1.policies, 'always'));
    } finally {
      write.mock.restore();
      syncBuiltinESMExports();
    }
    started.gate.dispose();
    assert.strictEqual(onDisk().default, 'skip');
    assert.match(started.gate.getStatus().errors.join('\n'), /At start, the recipe's changes to gate\.json \("default"\) weren't saved \(EACCES: permission denied, open\)/);
  });

  it('compares a rule the gate leaves out as written, so a hand edit to it is kept', () => {
    // A behavior given as a list isn't read, so the gate leaves the rule out, and the merge compares it as written.
    const odd = (behavior: string) => ({ name: 'odd', match: { scope: ['external-message'] }, behavior: [behavior] }) as unknown as GatePolicy;
    const policies = recipe1.policies.slice(0, 3);
    start(config([...policies, odd('defer'), catchAll], 'always')).gate.dispose();
    const edited = { ...onDisk(), policies: onDisk().policies.map((p) => (p.name === 'odd' ? odd('skip') : p)) };
    writeFileSync(configPath, JSON.stringify(edited, null, 2));
    const { gate, logged } = start(config([...policies, rule('odd', 'odd'), catchAll], 'always'));
    gate.dispose();
    assert.deepStrictEqual(onDisk().policies.find((p) => p.name === 'odd'), odd('skip'));
    assert.match(logged.join('\n'), /kept as edited, though the recipe changed or dropped it: "odd"/);
  });

  it('names the changes a merge write may not all have saved, when it fails after leaving gate.json loading', (t) => {
    start(recipe1).gate.dispose();
    const original = fs.writeFileSync;
    const write = t.mock.method(fs, 'writeFileSync', (path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      original(path, data, ...(rest as []));
      if (path === configPath) throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO', syscall: 'close' });
    });
    syncBuiltinESMExports();
    let started: ReturnType<typeof start>;
    try {
      started = start(recipe2);
    } finally {
      write.mock.restore();
      syncBuiltinESMExports();
    }
    started.gate.dispose();
    assert.deepStrictEqual(names(onDisk()), ['dm', 'agents', 'catch-all']);
    assert.deepStrictEqual(recorded(), recipe1, 'nothing recorded');
    assert.match(started.gate.getStatus().errors.join('\n'), /At start, the recipe's changes to gate\.json \("zoo", "sync" and "dm"\) may not all have been saved \(EIO: i\/o error, close\): the gate started with gate\.json as the write left it\. Whoever runs this host can fix what kept them from being written\./);
  });

  it("leaves the record as it was at a start that can't add to gate.json or doesn't use it", () => {
    start(recipe1).gate.dispose();
    const recorded1 = readFileSync(lastRecipePath(configPath), 'utf-8');
    // No list of rules to add to.
    writeFileSync(configPath, JSON.stringify({ policies: 'later', default: 'always' }));
    start(recipe2).gate.dispose();
    assert.strictEqual(readFileSync(lastRecipePath(configPath), 'utf-8'), recorded1);
    // No rules the gate reads, under a default that holds events back, and leaving out a rule that could wake
    // the agent: gate.json isn't used at this start.
    writeFileSync(configPath, JSON.stringify({ policies: [{ name: 'agents', behavior: ['always'] }], default: 'skip' }));
    start(recipe2).gate.dispose();
    assert.strictEqual(readFileSync(lastRecipePath(configPath), 'utf-8'), recorded1);
  });

  it('names the default a refused merge would have written, not the one gate.json holds', () => {
    const recipeA = config([rule('dm', 'dm'), catchAll], 'always');
    start(recipeA).gate.dispose();
    // A rule the gate leaves out, which could wake the agent: harmless under "always", refused under "skip".
    const odd = { name: 'odd', behavior: ['always'] } as unknown as GatePolicy;
    writeFileSync(configPath, JSON.stringify({ ...recipeA, policies: [...recipeA.policies, odd] }, null, 2));
    const before = readFileSync(configPath, 'utf-8');
    const { gate } = start(config([rule('dm', 'dm'), catchAll], 'skip'));
    gate.dispose();
    assert.strictEqual(readFileSync(configPath, 'utf-8'), before);
    assert.match(gate.getStatus().errors.join('\n'), /At start, the recipe's changes to gate\.json \("default"\) weren't saved \(with them, gate\.json would leave out a rule that could wake the agent, and under its default, "skip", it wouldn't be used\), so the gate started with gate\.json's rules as they were\. A start applies them once what kept them out is fixed\./);
  });

  it('runs what a merge write that fails partway held, and names the changes it was writing', (t) => {
    start(recipe1).gate.dispose();
    const original = fs.writeFileSync;
    const write = t.mock.method(fs, 'writeFileSync', (path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      if (path !== configPath) return original(path, data, ...(rest as []));
      const text = String(data);
      original(path, text.slice(0, Math.floor(text.length / 2)));
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
    });
    syncBuiltinESMExports();
    let started: ReturnType<typeof start>;
    try {
      started = start(recipe2);
    } finally {
      write.mock.restore();
      syncBuiltinESMExports();
    }
    const { gate } = started;
    gate.dispose();
    // What the write held: the merge's rules, "zoo" and "sync" removed and "dm" redefined, not gate.json's plus additions.
    assert.deepStrictEqual(gate.getStatus().policies.map((p) => p.name), ['dm', 'agents', 'catch-all']);
    assert.deepStrictEqual(recorded(), recipe1, 'nothing recorded');
    const errors = gate.getStatus().errors.join('\n');
    assert.match(errors, /At start, writing the recipe's changes to gate\.json \("agents", "zoo", "sync" and "dm"\) failed partway \(ENOSPC: no space left on device, write\), so gate\.json may be left part-written\. The gate runs the rules that write held, which aren't saved/);
    assert.match(errors, /the gate runs the rules its start was writing to gate\.json\./);
    assert.doesNotMatch(errors, /the ones it was adding/);
  });

  it('seeds gate.json at the first start with a recipe that names a rule twice, as given, and records nothing', () => {
    const twice = config([rule('dm', 'dm'), rule('dm', 'dm-again'), catchAll]);
    const { gate } = start(twice);
    gate.dispose();
    assert.deepStrictEqual(onDisk(), twice);
    assert.strictEqual(existsSync(lastRecipePath(configPath)), false);
    assert.ok(gate.getStatus().errors.includes(
      'At start, the recipe names the rule "dm" twice, so gate.json was seeded with it as given and it wasn\'t recorded as the '
        + 'recipe last applied: a later start merges the recipe by name, once gate.json and the recipe name each rule once.',
    ), JSON.stringify(gate.getStatus().errors));
  });

  it('seeds nothing and records nothing at the first start with a recipe refused whole', () => {
    const { gate } = start({ policies: [], default: 'sometimes' } as unknown as GateConfig);
    gate.dispose();
    assert.strictEqual(existsSync(configPath), false);
    assert.strictEqual(existsSync(lastRecipePath(configPath)), false);
    assert.match(gate.getStatus().errors.join('\n'), /At start, the host's starting rules weren't used/);
  });

  it("leaves gate.json as it is when a later start's recipe doesn't validate, and says it's the recipe", () => {
    start(recipe1).gate.dispose();
    const before = readFileSync(configPath, 'utf-8');
    const { gate } = start({ policies: [], default: 'sometimes' } as unknown as GateConfig);
    gate.dispose();
    assert.strictEqual(readFileSync(configPath, 'utf-8'), before);
    assert.match(gate.getStatus().errors.join('\n'), /At start, the host's starting rules weren't used/);
    assert.deepStrictEqual(recorded(), recipe1, 'the record stays');
  });

  it("writes a default-only recipe change to gate.json, and seeds gate.json with the recipe as given", () => {
    start({ policies: recipe1.policies } as GateConfig).gate.dispose();
    // gate.json and the record each hold the recipe as given.
    assert.strictEqual('default' in onDisk(), false);
    assert.strictEqual('default' in recorded(), false);
    start(config(recipe1.policies, 'skip')).gate.dispose();
    assert.strictEqual(onDisk().default, 'skip');
    // A recipe that drops its default takes gate.json's unedited one with it, so the gate reads "always".
    const dropped = start({ policies: recipe1.policies } as GateConfig);
    dropped.gate.dispose();
    assert.strictEqual('default' in onDisk(), false);
    assert.match(dropped.logged.join('\n'), /default skip → always/);
  });

  it('runs a rule edited at run time, kept through a restart that writes nothing', () => {
    const first = start(recipe1).gate;
    first.addPolicy(rule('dm', 'dm-edited', 'skip'));
    first.dispose();
    const { gate } = start(recipe1);
    try {
      assert.strictEqual(gate.evaluate(ext('dm-edited')).policyName, 'dm');
      assert.strictEqual(gate.evaluate(ext('dm-edited')).trigger, false);
    } finally {
      gate.dispose();
    }
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

  it('writes gate.json in place, so a hard link to it sees the merge', () => {
    start(recipe1).gate.dispose();
    const linked = join(dir, 'hard-link.json');
    linkSync(configPath, linked);
    start(recipe2).gate.dispose();
    assert.deepStrictEqual(names(JSON.parse(readFileSync(linked, 'utf-8'))), ['dm', 'agents', 'catch-all']);
  });

  it('seeds a dangling symlinked gate.json at its target, keeping the link', () => {
    mkdirSync(join(dir, '_config'), { recursive: true });
    const target = join(dir, 'kept-elsewhere.json');
    symlinkSync(target, configPath);
    start(recipe1).gate.dispose();
    assert.ok(lstatSync(configPath).isSymbolicLink());
    assert.deepStrictEqual(JSON.parse(readFileSync(target, 'utf-8')), recipe1);
  });

  it("leaves a gate.json that doesn't load as it is, and records no recipe", () => {
    mkdirSync(join(dir, '_config'), { recursive: true });
    writeFileSync(configPath, '{ "policies": [ not json');
    const { gate, traces } = start(recipe1);
    gate.dispose();
    assert.strictEqual(readFileSync(configPath, 'utf-8'), '{ "policies": [ not json');
    assert.strictEqual(existsSync(lastRecipePath(configPath)), false);
    assert.ok(!traces.some((t) => t.type === 'gate:config-reconciled'), 'nothing merged');
    // The gate runs on the recipe as given.
    assert.strictEqual(gate.evaluate(ext('zoo')).policyName, 'zoo');
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
      assert.strictEqual(
        unreached.notProbedNote,
        "No probe event matches these rules, so the probes above don't show what they do: the probes are a few MCPL chat events and a heartbeat, "
          + "and these rules ask for something none of them carries, such as another event type (a module's messages are external-message), "
          + 'a source, channel or path, or particular content, metadata or tags.',
      );
      assert.ok(unreached.probes.length > 0, 'the result gives probe rows');
      assert.ok(unreached.probes.every((p) => !p.wouldWake));
      assert.match(unreached.note ?? '', /the new rule matches no probe event \(see notProbed\)/);

      const wakeAll = add('add-2', { name: 'wake-all', match: {}, behavior: 'always' }) as Data & { probes: Array<{ changed?: unknown }> };
      assert.ok(wakeAll.probes.every((p) => 'changed' in p));
      assert.strictEqual(wakeAll.note, undefined);
      // Behind wake-all, a rule every probe reaches changes no winner.
      const shadowed = add('add-3', { name: 'also-all', match: {}, behavior: 'skip' });
      assert.deepStrictEqual(shadowed.notProbed, ['zulip-addressed']);
      assert.strictEqual(shadowed.note, 'No canonical probe changed its winning rule — the new rule affects none of the common chat/heartbeat shapes.');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A framework with the stock input rule, the given extra config, and the
   *  wake_add_rule dispatch and internals the tests below drive. */
  async function orderNotesFramework(extra: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-wake-add-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [],
      syncIntervalMs: 0,
      gate: {
        configPath: join(dir, 'gate.json'),
        config: { policies: [{ name: 'cli-input', match: { scope: ['external-message'] }, behavior: 'always' }], default: 'skip' },
      },
      ...extra,
    });
    const internals = framework as unknown as {
      dispatchWakeRuleToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
      pushEvent(event: { type: string; result?: { success: boolean; data?: unknown } }): void;
      setMcplServerConfig(config: { id: string; command: string; args: string[] }): void;
      eventGate: { getStatus(): { shadowWarnings: string[] } };
    };
    const traces: Array<{ type: string; [key: string]: unknown }> = [];
    framework.onTrace((event) => { traces.push(event as { type: string }); });
    const pushed: Array<{ type: string; result?: { success: boolean; data?: unknown } }> = [];
    internals.pushEvent = (event) => { pushed.push(event); };
    let calls = 0;
    const add = (input: unknown): string[] | undefined => {
      internals.dispatchWakeRuleToolCall('prime', { id: `add-${++calls}`, name: 'wake_add_rule', input });
      const result = pushed.filter((e) => e.type === 'tool-result').pop()?.result;
      assert.ok(result?.success, JSON.stringify(pushed));
      return (result!.data as { shadowWarnings?: string[] }).shadowWarnings;
    };
    const done = async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); };
    return { framework, internals, traces, add, done };
  }

  /** An MCPL server that exits at once: the framework still lists it. */
  const exitingServer = (id: string) => ({ id, command: process.execPath, args: ['-e', ''] });

  it("leaves out of its rule-order notes the types a rule's source never sends: an MCPL server's or the heartbeat's events aren't external-message", async () => {
    const { framework, internals, traces, add, done } = await orderNotesFramework({
      heartbeat: { defaults: { intervalSeconds: 3600 } },
      mcplServers: [exitingServer('world')],
    });
    try {
      // A server in the config: no note, and still none once it's
      // disconnected and gone from the connected servers.
      assert.strictEqual(add({ name: 'world', match: { source: 'world' }, behavior: 'always' }), undefined);
      await framework.disconnectMcplServer('world');
      assert.strictEqual(framework.listMcplServers().some((s) => s.id === 'world'), false);
      assert.deepStrictEqual(internals.eventGate.getStatus().shadowWarnings, []);

      // A source the framework doesn't know could send anything: the unsure note.
      const unknown = add({ name: 'other', match: { source: 'other' }, behavior: 'always' });
      assert.strictEqual(unknown?.length, 1);
      assert.match(unknown![0], /^"cli-input" comes first and takes every external-message event, so "other" sees none\. Nothing to do unless/);

      // Once it's a server, connected at runtime, the note goes from
      // gate_status and the trace says so.
      const before = traces.filter((t) => t.type === 'gate:shadow-warnings').length;
      internals.setMcplServerConfig(exitingServer('other'));
      assert.deepStrictEqual(internals.eventGate.getStatus().shadowWarnings, []);
      const cleared = traces.filter((t) => t.type === 'gate:shadow-warnings').slice(before);
      assert.deepStrictEqual(cleared.map((t) => [t.reason, t.warnings]), [['sources-changed', []]]);
      assert.strictEqual(add({ name: 'other', match: { source: 'other' }, behavior: 'skip' }), undefined);

      // The framework's heartbeat sends pushes only.
      assert.strictEqual(add({ name: 'heartbeat-wake', match: { source: 'heartbeat' }, behavior: 'always' }), undefined);
    } finally {
      await done();
    }
  });

  it("gives a heartbeat rule the unsure note when the framework runs no heartbeat", async () => {
    const { add, done } = await orderNotesFramework({});
    try {
      const notes = add({ name: 'heartbeat-wake', match: { source: 'heartbeat' }, behavior: 'always' });
      assert.strictEqual(notes?.length, 1);
      assert.match(notes![0], /so "heartbeat-wake" sees none\. Nothing to do unless/);
    } finally {
      await done();
    }
  });
});
