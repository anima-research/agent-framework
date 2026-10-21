/**
 * What a start does to an existing gate.json, given the recipe's gate config.
 *
 * The gate keeps the recipe it last applied in a file of its own beside
 * gate.json (`gate.recipe.json` for `gate.json`), written by the gate. A start
 * merges the recipe into gate.json three ways, rule by rule, against it:
 * - a rule as the last recipe left it follows the new recipe: it takes the
 *   new definition, or goes when the new recipe no longer declares it, so a
 *   renamed rule goes under its old name and comes in under its new one;
 * - a rule edited since the last recipe stays as edited;
 * - a rule both recipes declare, removed from gate.json since, comes back;
 * - a rule no recipe declared (added at run time, or by hand) stays;
 * - a rule new in the recipe comes in.
 *
 * Order: when gate.json still has the last recipe's rules in that recipe's
 * order, the recipe's rules take the new recipe's order, in the places
 * gate.json gives recipe rules, and every other rule keeps its place. When a
 * recipe rule was moved since (wake_add_rule's position moves one), gate.json's
 * order stays. Either way, a recipe rule new to gate.json goes before the
 * recipe rule that follows it there, or last when none does.
 * `default` follows the same rule as a definition.
 *
 * Without a last recipe, as at the first start after this change, nothing is
 * removed or redefined: the rules that match the recipe by name and definition
 * take its order, every other rule stays, and the line names those that differ
 * from the recipe or aren't in it. A rule that differs can be removed, and the
 * next start restores it from the recipe.
 */
import type { GateConfig, GatePolicy } from './types.js';

/** What a start changed, by rule name, for its trace and its log line. */
export interface RecipeChanges {
  added: string[];
  removed: string[];
  updated: string[];
  restored: string[];
  moved: string[];
  /** Edited since the last recipe, and kept, though the new recipe changed or dropped it. */
  keptEdited: string[];
  /** Kept, though the recipe declares the name with another definition. */
  differsFromRecipe: string[];
  /** Kept, and in no recipe: named at a start without a last recipe only. */
  outsideRecipe: string[];
  /** gate.json's order was kept, since a recipe rule was moved in it. */
  orderKept: boolean;
  defaultChange?: { from: string; to: string };
  /** The live `default`, kept as edited, though the recipe changed it. */
  defaultKept?: string;
}

/** The file beside gate.json that holds the recipe the gate last applied. */
export function lastRecipePath(configPath: string): string {
  return `${configPath.replace(/\.json$/, '')}.recipe.json`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** A config or policy as text that doesn't depend on its keys' order. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

const same = (a: GatePolicy, b: GatePolicy): boolean => canonical(a) === canonical(b);

/** The names in one longest sequence that `a` and `b` share in order. */
function longestShared(a: string[], b: string[]): Set<string> {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const shared = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      shared.add(a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] > table[i][j + 1]) {
      i++;
    } else {
      // On a tie, the result's rule is the one named as moved: the rule a
      // swap brought earlier, such as one the old appending left behind a
      // catch-all.
      j++;
    }
  }
  return shared;
}

/**
 * Merge `recipe` into `live` against `last`, the recipe last applied (null
 * when there is none). Pure: the caller reads and writes the files. All three
 * are validated configs.
 */
export function reconcileWithRecipe(
  live: GateConfig,
  recipe: GateConfig,
  last: GateConfig | null,
): { config: GateConfig; changes: RecipeChanges } {
  const changes: RecipeChanges = {
    added: [], removed: [], updated: [], restored: [], moved: [],
    keptEdited: [], differsFromRecipe: [], outsideRecipe: [], orderKept: false,
  };
  const byName = (config: GateConfig) => new Map(config.policies.map((p) => [p.name, p]));
  const inLive = byName(live);
  const inRecipe = byName(recipe);
  const inLast = last ? byName(last) : null;

  // The recipe's rules, which take its order, and the rest, which keep their place.
  const owned = new Map<string, GatePolicy>();
  const kept = new Map<string, GatePolicy>();
  for (const policy of live.policies) {
    const declared = inRecipe.get(policy.name);
    const before = inLast?.get(policy.name);
    if (!inLast) {
      if (declared && same(policy, declared)) {
        owned.set(policy.name, declared);
      } else {
        kept.set(policy.name, policy);
        (declared ? changes.differsFromRecipe : changes.outsideRecipe).push(policy.name);
      }
    } else if (before) {
      if (same(policy, before)) {
        if (declared) {
          owned.set(policy.name, declared);
          if (!same(declared, before)) changes.updated.push(policy.name);
        } else {
          changes.removed.push(policy.name);
        }
      } else {
        kept.set(policy.name, policy);
        if (!declared || !same(declared, before)) changes.keptEdited.push(policy.name);
      }
    } else if (declared) {
      if (same(policy, declared)) {
        owned.set(policy.name, declared);
      } else {
        kept.set(policy.name, policy);
        changes.differsFromRecipe.push(policy.name);
      }
    } else {
      kept.set(policy.name, policy);
    }
  }
  for (const declared of recipe.policies) {
    if (inLive.has(declared.name)) continue;
    owned.set(declared.name, declared);
    (inLast?.has(declared.name) ? changes.restored : changes.added).push(declared.name);
  }

  const liveOrder = live.policies.map((p) => p.name);
  const recipeOrder = recipe.policies.map((p) => p.name);
  const lastOrder = last ? last.policies.map((p) => p.name) : [];
  const followsLast = !inLast
    || canonical(liveOrder.filter((name) => inLast.has(name))) === canonical(lastOrder.filter((name) => inLive.has(name)));

  // The rules that stay, in gate.json's order.
  const staying = liveOrder.filter((name) => owned.has(name) || kept.has(name));
  let order: string[];
  if (followsLast) {
    // The recipe's rules fill the places recipe rules hold, in the recipe's order.
    const recipeRules = recipeOrder.filter((name) => owned.has(name) && inLive.has(name));
    let next = 0;
    order = staying.map((name) => (owned.has(name) ? recipeRules[next++] : name));
  } else {
    changes.orderKept = true;
    order = staying;
  }
  // A recipe rule new to gate.json goes before the recipe rule that follows it there.
  recipeOrder.forEach((name, index) => {
    if (!owned.has(name) || order.includes(name)) return;
    const following = recipeOrder.slice(index + 1).find((later) => order.includes(later));
    if (following === undefined) order.push(name);
    else order.splice(order.indexOf(following), 0, name);
  });

  const stayedInOrder = longestShared(liveOrder.filter((name) => order.includes(name)), order.filter((name) => inLive.has(name)));
  changes.moved = order.filter((name) => inLive.has(name) && !stayedInOrder.has(name));

  let defaultBehavior = live.default;
  if (last) {
    if ((live.default ?? 'always') === (last.default ?? 'always')) {
      defaultBehavior = recipe.default;
      if ((recipe.default ?? 'always') !== (live.default ?? 'always')) {
        changes.defaultChange = { from: live.default ?? 'always', to: recipe.default ?? 'always' };
      }
    } else if ((recipe.default ?? 'always') !== (last.default ?? 'always')) {
      changes.defaultKept = live.default ?? 'always';
    }
  }

  return {
    config: {
      ...live,
      policies: order.map((name) => (owned.get(name) ?? kept.get(name))!),
      default: defaultBehavior,
    },
    changes,
  };
}

/** The log line a start gives its changes, or null when it changed nothing worth saying. */
export function reconcileLine(changes: RecipeChanges): string | null {
  const parts: string[] = [];
  const list = (label: string, names: string[]) => {
    if (names.length > 0) parts.push(`${label} ${names.join(', ')}`);
  };
  list('added', changes.added);
  list('removed', changes.removed);
  list('updated', changes.updated);
  list('restored', changes.restored);
  list('moved', changes.moved);
  list('kept as edited, though the recipe changed or dropped it:', changes.keptEdited);
  if (changes.differsFromRecipe.length > 0) {
    parts.push(
      `kept, though the recipe defines it otherwise: ${changes.differsFromRecipe.join(', ')} `
        + '(remove such a rule, and the next start restores it from the recipe)',
    );
  }
  list('kept, not in the recipe:', changes.outsideRecipe);
  if (changes.defaultChange) parts.push(`default ${changes.defaultChange.from} → ${changes.defaultChange.to}`);
  if (changes.defaultKept) parts.push(`default kept as edited (${changes.defaultKept}), though the recipe changed it`);
  if (changes.orderKept) parts.push("gate.json's order kept, since a recipe rule was moved in it");
  return parts.length > 0 ? `[gate] the recipe was applied to gate.json: ${parts.join('; ')}` : null;
}
