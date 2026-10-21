- A restart now applies the recipe's wake rules to the live gate, where it only appended rules under new names before (#654). The gate keeps the recipe it last applied beside `gate.json`, in `gate.recipe.json`, and merges the recipe against it at each start:
  - a rule the recipe dropped goes, and a renamed rule takes its new name at the recipe's place, rather than landing behind a catch-all while its old name keeps matching;
  - a rule the recipe moved or redefined takes its new place and definition;
  - a rule edited at run time or by hand stays as edited, and a rule added at run time stays where it is;
  - a rule both recipes declare that was removed at run time comes back at its recipe place;
  - a recipe rule moved at run time, as `wake_add_rule` with a position does, keeps `gate.json`'s order;
  - an unedited `default` takes the recipe's.

  Each start that changes something logs one line naming the rules it added, removed, updated, restored and moved, and the `gate:config-reconciled` trace carries the same.
  - **The first restart after upgrading** has no recorded recipe, so it removes and redefines nothing. It puts the rules that match the recipe into the recipe's order, and names the rules that differ from the recipe or aren't in it. A rule that differs can be removed, and the next restart restores it from the recipe.
- `wake_add_rule`'s result names the rules no probe event reaches (`notProbed`), such as one scoped to `external-message`, so its probe rows of `default:skip` don't read as their effect (#654).
