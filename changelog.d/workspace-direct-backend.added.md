- Workspace mounts take a `backend` (recipe: `modules.workspace.mounts[].backend`,
  default `chronicle`). With `backend: 'direct'` the same tools — `read`,
  `write`, `edit`, `delete`, `ls`, `glob`, `grep`, `read_image` — operate on the
  mounted directory itself: no Chronicle tree state, so there is no second
  copy that can go stale behind shell-side edits, and nothing to materialize
  or sync. `materialize` and `sync` report a direct mount under `skipped`
  instead of touching it; `status` and a path-less `ls` show each mount's
  backend. Direct writes are atomic (temp file + rename), `edit` refuses a
  file another writer changed since it was read, containment and symlink
  rules match the chronicle backend's disk reads, and recursive listings
  report `truncated` when they stop at the file cap rather than going quiet.
  Direct edits are not branch-scoped or undoable. A mount switched back from
  direct to chronicle syncs disk into the store before its first materialize,
  so the stale tree never overwrites disk.
- `write` takes `append: true` on both backends, adding to the end of the file
  (creating it if missing) instead of replacing it.
