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
 *
 * Rules are compared by what they mean and kept as written. Two rules agree
 * when the gate reads them the same, so a rule `wake_add_rule` wrote as the
 * gate reads it agrees with the recipe's rule as written, and a change to a
 * field the gate doesn't read alone isn't an edit; the caller gives the
 * meaning (`meaningOf`). A rule the gate leaves out has no reading, so it is
 * compared as written, a change to any of its fields an edit. A rule that agrees with the recipe stays as gate.json
 * holds it, and one that follows the recipe takes the recipe's rule as
 * written. A rule with no name stays where gate.json holds it, and a recipe's
 * rule with no name is never merged: the merge keys rules by name.
 */

import { quotedValue } from '../supplied-text.js';

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
    // No prototype, so a key such as "__proto__", which JSON.parse gives as an
    // own field, is copied as one rather than setting the prototype.
    const out: Record<string, unknown> = Object.create(null);
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

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** Changes with nothing in them, for a start to fill. */
export function noChanges(): RecipeChanges {
  return {
    added: [], removed: [], updated: [], restored: [], moved: [],
    keptEdited: [], differsFromRecipe: [], outsideRecipe: [], orderKept: false,
  };
}

/** A gate config as written: its rule list and its `default`, each as given. */
export interface WrittenConfig { rules: readonly unknown[]; default: unknown }

/** A rule's name as written, when it has a usable one. */
export function ruleName(rule: unknown): string | undefined {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return undefined;
  const name = (rule as { name?: unknown }).name;
  return typeof name === 'string' && name ? name : undefined;
}

/** A rule name the list gives more than once, if any: the merge keys rules by name. */
export function duplicateName(rules: readonly unknown[]): string | undefined {
  const seen = new Set<string>();
  for (const rule of rules) {
    const name = ruleName(rule);
    if (name === undefined) continue;
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return undefined;
}

/** A `default` as the gate reads one: left out, null or "" is "always". */
function behaviorOf(value: unknown): unknown {
  return value === undefined || value === null || value === '' ? 'always' : value;
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
 * when there is none), each as written. Pure: the caller reads and writes the
 * files, and gives `meaningOf`, a rule's meaning as a string two rules share
 * when they mean the same (as written, unless given). Returns the rule list
 * and `default` to write, each as written, and whether `default` changed.
 * Throws when `live` or `recipe` names a rule twice, since the merge keys
 * rules by name.
 */
export function reconcileWithRecipe(
  live: WrittenConfig,
  recipe: WrittenConfig,
  last: WrittenConfig | null,
  meaningOf: (rule: unknown) => string = canonical,
): { rules: unknown[]; default: unknown; defaultChanged: boolean; changes: RecipeChanges } {
  const agree = (a: unknown, b: unknown): boolean => meaningOf(a) === meaningOf(b);
  const liveDuplicate = duplicateName(live.rules);
  if (liveDuplicate !== undefined) {
    throw new Error(`gate.json names the rule ${quotedValue(liveDuplicate)} twice`);
  }
  const recipeDuplicate = duplicateName(recipe.rules);
  if (recipeDuplicate !== undefined) {
    throw new Error(`the recipe names the rule ${quotedValue(recipeDuplicate)} twice`);
  }

  const changes = noChanges();
  // Each rule by its name; a rule with no name by a key no name can be, so
  // it keeps its place and matches nothing.
  const keyOf = (rule: unknown, index: number): string => ruleName(rule) ?? `\u0000nameless ${index}`;
  const byName = (rules: readonly unknown[]) => new Map(rules.flatMap((rule) => {
    const name = ruleName(rule);
    return name === undefined ? [] : [[name, rule] as const];
  }));
  const inLive = new Map(live.rules.map((rule, index) => [keyOf(rule, index), rule] as const));
  const inRecipe = byName(recipe.rules);
  const inLast = last ? byName(last.rules) : null;

  // Each rule gate.json keeps, with its definition, and which of them take
  // the recipe's order (`ordered`); the rest keep their places.
  const definitions = new Map<string, unknown>();
  const ordered = new Set<string>();
  live.rules.forEach((rule, index) => {
    const name = keyOf(rule, index);
    const declared = inRecipe.get(name);
    const before = inLast?.get(name);
    if (declared !== undefined && agree(rule, declared)) {
      // As the recipe has it: kept as written, whatever the record says, and
      // nothing to change or name.
      definitions.set(name, rule);
      ordered.add(name);
    } else if (ruleName(rule) === undefined) {
      definitions.set(name, rule);
    } else if (!inLast) {
      definitions.set(name, rule);
      (declared !== undefined ? changes.differsFromRecipe : changes.outsideRecipe).push(name);
    } else if (before !== undefined) {
      const edited = !agree(rule, before);
      if (declared === undefined) {
        if (edited) {
          definitions.set(name, rule);
          changes.keptEdited.push(name);
        } else {
          changes.removed.push(name);
        }
      } else {
        // Both recipes declare it: it's a recipe rule, so it takes the recipe's order.
        ordered.add(name);
        if (edited) {
          definitions.set(name, rule);
          if (!agree(declared, before)) changes.keptEdited.push(name);
        } else {
          definitions.set(name, declared);
          changes.updated.push(name);
        }
      }
    } else {
      // No recipe declared it as it stands: a run-time rule, or one the recipe
      // now declares otherwise.
      definitions.set(name, rule);
      if (declared !== undefined) changes.differsFromRecipe.push(name);
    }
  });

  const liveOrder = live.rules.map(keyOf);
  const recipeOrder = recipe.rules.flatMap((rule) => {
    const name = ruleName(rule);
    return name === undefined ? [] : [name];
  });
  const staying = liveOrder.filter((name) => definitions.has(name));

  // Whether gate.json holds the rules both recipes declare in the last recipe's order.
  const shared = (order: string[]) => order.filter((name) => inLast?.has(name) && inRecipe.has(name) && inLive.has(name));
  const lastOrder = last ? last.rules.flatMap((rule) => {
    const name = ruleName(rule);
    return name === undefined ? [] : [name];
  }) : [];
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

  // `default` as the gate reads it, compared as written once read.
  const liveDefault = behaviorOf(live.default);
  const recipeDefault = behaviorOf(recipe.default);
  let defaultBehavior = live.default;
  let defaultChanged = false;
  const shownBehavior = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));
  if (!last) {
    if (!same(liveDefault, recipeDefault)) changes.defaultDiffers = { kept: shownBehavior(liveDefault), recipe: shownBehavior(recipeDefault) };
  } else {
    const lastDefault = behaviorOf(last.default);
    if (same(liveDefault, lastDefault) || same(liveDefault, recipeDefault)) {
      if (!same(recipeDefault, liveDefault)) {
        defaultBehavior = recipe.default;
        defaultChanged = true;
        changes.defaultChange = { from: shownBehavior(liveDefault), to: shownBehavior(recipeDefault) };
      }
    } else if (!same(recipeDefault, lastDefault)) {
      changes.defaultKept = shownBehavior(liveDefault);
    }
  }

  return {
    rules: order.map((name) => definitions.get(name)),
    default: defaultBehavior,
    defaultChanged,
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
