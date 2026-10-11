- Workspace mounts take a `backend` (recipe: `modules.workspace.mounts[].backend`).
  With `'direct'` — now the default — the same tools (`read`, `write`, `edit`,
  `delete`, `ls`, `glob`, `grep`, `read_image`) operate on the mounted
  directory itself: no Chronicle tree state, so there is no second copy that
  can go stale behind shell-side edits, and nothing to materialize or sync.
  `materialize` and `sync` report a direct mount under `skipped` instead of
  touching it; `status` and a path-less `ls` show each mount's backend. Direct
  writes are atomic (temp file + rename), `edit` refuses a file another writer
  changed since it was read, containment and symlink rules match the
  chronicle backend's disk reads, and recursive listings report `truncated`
  when they stop at the file cap rather than going quiet. `backend:
  'chronicle'` keeps the previous behaviour (branch-scoped, undoable edits
  that reach disk on materialize). A mount switched back from direct to
  chronicle syncs disk into the store before its first materialize, so the
  stale tree never overwrites disk.
- `write` takes `append: true` on both backends, adding to the end of the file
  (creating it if missing) instead of replacing it. On a direct mount the
  append is a single `O_APPEND` write, safe to interleave with a shell `>>`.
- New workspace tool `watch`: the agent registers a file or directory (or a
  whole mount) and is woken, with a context line naming the path and op,
  whenever something other than its own tools creates, modifies or deletes
  under it. Watches persist in module state across restarts. On a direct mount
  the watcher starts on demand; a chronicle mount needs `watch: 'always'`.
