- **Workspace tool-output consumers:** `glob` returns `matches` as objects,
  `{ path, state, size?, mimeType?, conflict?, note? }`, instead of path strings. `sync` reports
  `conflicts` as `{ path, kind, diskCopy }`. `sync` without a path no longer replaces a workspace
  draft with a differing disk copy; the path stays a conflict until a `sync` of that path or a
  forced `materialize` resolves it. `ls` and `grep` only add fields (each `ls` entry's `state`,
  and grep's `state`, `version`, `skipped` and `incomplete`).
- **Hosts and module authors reading workspace internals:** `MountState` no longer has
  `materializedHashes` or `refusedPaths`. Disk-agreement evidence lives in `workspace/disk-agreement`
  chronicle records, and branch-local intent in each mount's `workspace/<mount>/intent` tree state.
