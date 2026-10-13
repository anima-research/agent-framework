- **Workspace tool-output consumers:** `glob` returns `matches` as objects,
  `{ path, state, size?, mimeType?, conflict?, note? }`, instead of path strings. `sync` reports
  `conflicts` as `{ path, kind, diskCopy }`. `sync` without a path no longer replaces a workspace
  draft with a differing disk copy: the draft stays, and where disk changed too, the path is a
  conflict until a `sync` of that path or a forced `materialize` resolves it, or the two converge.
  For an `unknown-provenance` or `store-origin-collision` conflict, the forced `materialize` must
  name the path: one without a path leaves it. `ls`, `grep` and `sync` otherwise only add fields
  (each `ls` file entry's `state`; grep's `state`, `version`, `skipped` and `incomplete`; a path
  sync's `discarded`).
- **Hosts and module authors reading workspace internals:** `MountState` no longer has
  `materializedHashes` or `refusedPaths`. Disk-agreement evidence lives in `workspace/disk-agreement`
  chronicle records, and branch-local intent in each mount's `workspace/<mount>/intent` tree state.
  The module's saved state carries neither field, so a build from #169's branch started on a
  store this release wrote begins with no freshness baselines.
- **Prompt cache:** the descriptions of the workspace's `ls`, `glob`, `grep`, `sync`,
  `materialize` and `delete` tools change, and `sync` and `materialize` take new parameters, so
  the first request after the upgrade that carries those tools' definitions misses the cache from
  its tool block on.
