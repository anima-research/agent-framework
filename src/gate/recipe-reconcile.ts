/**
 * What a start does to an existing gate.json, given the recipe's gate config.
 *
 * The gate keeps the recipe it last applied in a file of its own beside
 * gate.json (`gate.recipe.json` for `gate.json`), written by the gate. A start
 * merges the recipe into gate.json three ways, rule by rule, against it:
 * - a rule as the last recipe left it follows the new recipe: it takes the
 *   new definition, or goes when the new recipe no longer declares it, so a
 *   renamed rule goes under its old name and comes in under its new one;
 * - a rule edited since the last recipe keeps its definition, unless it now
 *   agrees with the recipe's;
 * - a rule both recipes declare, removed from gate.json since, comes back;
 * - a rule no recipe declared (added at run time, or by hand) stays, and if
 *   the recipe now declares it as it stands, it's the recipe's from then on;
 * - a rule new in the recipe comes in.
 *
 * Order is an edit of its own, apart from a rule's definition. When gate.json
 * holds the rules both recipes declare in the last recipe's order, the recipe's
 * rules take the new recipe's order, in the places gate.json gives them, and
 * every other rule keeps its place. When one of them was moved since
 * (wake_add_rule's position moves one), gate.json's order stays. Either way, a
 * recipe rule new to gate.json goes before the recipe rule that follows it
 * there, or after the one before it when none follows.
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
  /** gate.json's order was kept, though the recipe changed its order, since a recipe rule was moved in it. */
  orderKept: boolean;
  defaultChange?: { from: string; to: string };
  /** The live `default`, kept as edited, though the recipe changed it. */
  defaultKept?: string;
  /** At a start without a last recipe: the live `default`, kept, and the recipe's, which differs. */
  defaultDiffers?: { kept: string; recipe: string };
  /** Why the recorded recipe couldn't be read, when it exists and doesn't read. */
  recordUnreadable?: string;
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

/** A rule name the config gives more than once, if any: the merge keys rules by name. */
export function duplicateName(config: GateConfig): string | undefined {
  const seen = new Set<string>();
  for (const policy of config.policies) {
    if (seen.has(policy.name)) return policy.name;
    seen.add(policy.name);
  }
  return undefined;
}

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
 * are validated configs. Throws when `live` or `recipe` names a rule twice,
 * since the merge keys rules by name.
 */
export function reconcileWithRecipe(
  live: GateConfig,
  recipe: GateConfig,
  last: GateConfig | null,
): { config: GateConfig; changes: RecipeChanges } {
  const liveDuplicate = duplicateName(live);
  if (liveDuplicate !== undefined) {
    throw new Error(`gate.json named the rule "${liveDuplicate}" twice, so the recipe wasn't applied: the merge needs one rule per name`);
  }
  const recipeDuplicate = duplicateName(recipe);
  if (recipeDuplicate !== undefined) {
    throw new Error(`the recipe named the rule "${recipeDuplicate}" twice, so it wasn't applied: the merge needs one rule per name`);
  }

  const changes: RecipeChanges = {
    added: [], removed: [], updated: [], restored: [], moved: [],
    keptEdited: [], differsFromRecipe: [], outsideRecipe: [], orderKept: false,
  };
  const byName = (config: GateConfig) => new Map(config.policies.map((p) => [p.name, p]));
  const inLive = byName(live);
  const inRecipe = byName(recipe);
  const inLast = last ? byName(last) : null;

  // Each rule gate.json keeps, with its definition, and which of them take
  // the recipe's order (`ordered`); the rest keep their places.
  const definitions = new Map<string, GatePolicy>();
  const ordered = new Set<string>();
  for (const policy of live.policies) {
    const declared = inRecipe.get(policy.name);
    const before = inLast?.get(policy.name);
    if (declared && same(policy, declared)) {
      // As the recipe has it: the recipe's, whatever the record says, and
      // nothing to change or name.
      definitions.set(policy.name, declared);
      ordered.add(policy.name);
    } else if (!inLast) {
      definitions.set(policy.name, policy);
      (declared ? changes.differsFromRecipe : changes.outsideRecipe).push(policy.name);
    } else if (before) {
      const edited = !same(policy, before);
      if (!declared) {
        if (edited) {
          definitions.set(policy.name, policy);
          changes.keptEdited.push(policy.name);
        } else {
          changes.removed.push(policy.name);
        }
      } else {
        // Both recipes declare it: it's a recipe rule, so it takes the recipe's order.
        ordered.add(policy.name);
        if (edited) {
          definitions.set(policy.name, policy);
          if (!same(declared, before)) changes.keptEdited.push(policy.name);
        } else {
          definitions.set(policy.name, declared);
          changes.updated.push(policy.name);
        }
      }
    } else {
      // No recipe declared it as it stands: a run-time rule, or one the recipe
      // now declares otherwise.
      definitions.set(policy.name, policy);
      if (declared) changes.differsFromRecipe.push(policy.name);
    }
  }

  const liveOrder = live.policies.map((p) => p.name);
  const recipeOrder = recipe.policies.map((p) => p.name);
  const staying = liveOrder.filter((name) => definitions.has(name));

  // Whether gate.json holds the rules both recipes declare in the last recipe's order.
  const shared = (order: string[]) => order.filter((name) => inLast?.has(name) && inRecipe.has(name) && inLive.has(name));
  const lastOrder = last ? last.policies.map((p) => p.name) : [];
  const followsLast = canonical(shared(liveOrder)) === canonical(shared(lastOrder));

  let order: string[];
  if (followsLast) {
    // The recipe's rules fill the places its rules hold, in the recipe's order.
    const recipeRules = recipeOrder.filter((name) => ordered.has(name));
    let next = 0;
    order = staying.map((name) => (ordered.has(name) ? recipeRules[next++] : name));
  } else {
    order = staying;
    // Named only when it holds something back: the recipe reordered these
    // rules, and gate.json doesn't already hold the recipe's order.
    changes.orderKept = canonical(shared(recipeOrder)) !== canonical(shared(lastOrder))
      && canonical(shared(liveOrder)) !== canonical(shared(recipeOrder));
  }
  // A recipe rule new to gate.json goes before the recipe rule that follows it
  // there, or after the one before it when none follows.
  recipeOrder.forEach((name, index) => {
    if (inLive.has(name)) return;
    definitions.set(name, inRecipe.get(name)!);
    (inLast?.has(name) ? changes.restored : changes.added).push(name);
    const following = recipeOrder.slice(index + 1).find((later) => order.includes(later));
    if (following !== undefined) {
      order.splice(order.indexOf(following), 0, name);
      return;
    }
    const preceding = recipeOrder.slice(0, index).reverse().find((earlier) => order.includes(earlier));
    if (preceding !== undefined) order.splice(order.indexOf(preceding) + 1, 0, name);
    else order.push(name);
  });

  // Only the recipe's rules move; every other rule keeps its place.
  const stayedInOrder = longestShared(staying.filter((name) => ordered.has(name)), order.filter((name) => ordered.has(name)));
  changes.moved = order.filter((name) => ordered.has(name) && !stayedInOrder.has(name));

  const liveDefault = live.default ?? 'always';
  const recipeDefault = recipe.default ?? 'always';
  let defaultBehavior = live.default;
  if (!last) {
    if (liveDefault !== recipeDefault) changes.defaultDiffers = { kept: liveDefault, recipe: recipeDefault };
  } else {
    const lastDefault = last.default ?? 'always';
    if (liveDefault === lastDefault || liveDefault === recipeDefault) {
      defaultBehavior = recipe.default;
      if (recipeDefault !== liveDefault) changes.defaultChange = { from: liveDefault, to: recipeDefault };
    } else if (recipeDefault !== lastDefault) {
      changes.defaultKept = liveDefault;
    }
  }

  return {
    config: {
      ...live,
      policies: order.map((name) => definitions.get(name)!),
      default: defaultBehavior,
    },
    changes,
  };
}

/** The log line a start gives its changes, or null when it changed nothing worth saying. */
export function reconcileLine(changes: RecipeChanges): string | null {
  const parts: string[] = [];
  if (changes.recordUnreadable !== undefined) {
    parts.push(`the recorded recipe couldn't be read (${changes.recordUnreadable}), so this start removed and redefined nothing`);
  }
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
  if (changes.outsideRecipe.length > 0) {
    parts.push(
      `kept, not in the recipe: ${changes.outsideRecipe.join(', ')} `
        + "(a stale one can be removed, and no start brings it back)",
    );
  }
  if (changes.defaultChange) parts.push(`default ${changes.defaultChange.from} → ${changes.defaultChange.to}`);
  if (changes.defaultKept) parts.push(`default kept as edited (${changes.defaultKept}), though the recipe changed it`);
  if (changes.defaultDiffers) {
    parts.push(
      `default kept as gate.json has it (${changes.defaultDiffers.kept}), though the recipe's is ${changes.defaultDiffers.recipe} `
        + "(set it to the recipe's, and later starts follow the recipe)",
    );
  }
  if (changes.orderKept) parts.push("gate.json's order kept, though the recipe reordered its rules, since a recipe rule was moved in it");
  return parts.length > 0 ? `[gate] the recipe was applied to gate.json: ${parts.join('; ')}` : null;
}
