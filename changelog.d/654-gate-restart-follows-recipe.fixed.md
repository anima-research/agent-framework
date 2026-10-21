- A start now applies the recipe's wake rules to an existing `gate.json`, where it only appended rules under new names before (#654). The gate keeps the recipe it last applied beside `gate.json`, in `gate.recipe.json`, and merges the recipe against it at each start:
  - a rule the recipe dropped goes, and a renamed rule takes its new name at the recipe's place, rather than landing behind a catch-all while its old name keeps matching;
  - a rule the recipe added, moved or redefined takes its place and definition;
  - a rule edited at run time or by hand keeps its definition, even when the recipe drops or changes it, and a rule added at run time stays where it is;
  - a rule both recipes declare that was removed at run time comes back at its recipe place;
  - a recipe rule moved at run time, as `wake_add_rule` with a position does, keeps `gate.json`'s order;
  - an unedited `default` takes the recipe's.

  Each start that merges into an existing `gate.json` and changes something logs one line naming the rules it added, removed, updated, restored, moved and kept, and the `gate:config-reconciled` trace carries the same lists. A start that can't apply the recipe, such as when `gate.json` or the recipe names a rule twice, applies nothing and says why in the log, the gate's status and a `gate:config-error` trace, and the error stays in status until the gate is next created.
  - **The first start after upgrading** has no recorded recipe, so it removes and redefines nothing. It puts the rules that match the recipe into the recipe's order, and names the rules that differ from the recipe or aren't in it. A rule that differs can be removed, and the next start restores it from the recipe.
- `wake_add_rule`'s result names the rules no probe event reaches (`notProbed`), such as one scoped to `external-message`, so its probe rows of `default:skip` don't read as their effect (#654).
