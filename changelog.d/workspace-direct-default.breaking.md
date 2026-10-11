- **Recipe authors and hosts:** workspace mounts now default to
  `backend: 'direct'`. A mount that omits `backend` reads and writes its
  directory directly: its Chronicle tree state is no longer registered or
  consulted, `materialize`/`sync` skip it, and its edits are not branch-scoped
  or undoable. Set `backend: 'chronicle'` on any mount that needs the tree
  (a config mount the host rewinds with `materializeMount`, a mount whose
  files must follow conversation branches). Hosts that construct
  `MountConfig`s programmatically must pass `backend` through from the recipe
  and pin their own tree-dependent mounts to `'chronicle'`. Existing stores
  keep their tree states untouched; upgrading a mount to direct abandons the
  tree in place (disk is what the resident already saw via shell), and a
  later switch back syncs disk into the store before the first materialize.
