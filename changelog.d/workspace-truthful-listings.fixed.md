- **Workspace listings tell the truth about disk, and no scan discards a workspace edit.** `ls`,
  `glob` and `grep` check their scope against disk before answering, under one rule over disk, the
  workspace store and what disk last agreed with. Files created by a shell show up, including
  binary and oversize ones, listed as `disk-only` with their size and, for images, their type.
  Files deleted by a shell leave the workspace on every scan path: a watcher event, `sync`, a
  listing, the scan after a restart, and a watcher reattach. Each entry carries a state:
  `synced`, `workspace-draft`, `workspace-deleted`, `not-in-branch`, `disk-only`, `conflict` (with
  its kind) or `disk-missing-provenance-unknown`. Where disk couldn't be checked, the state is
  `unverified`, and `incomplete` names the unreadable, ignored or capped regions. A pending
  workspace edit is never overwritten by a scan, a watcher event or a lazy read. When disk and
  the workspace both changed, the path becomes a conflict that stays until a `sync` of that path
  (take disk), a forced `materialize` (take the workspace) or convergence. A text disk version is
  kept in the store; a binary or oversize one is referenced, and the listing says if it changed
  since. `grep` labels a kept disk version `recorded-disk` once disk has changed since, and lists
  a conflict's disk side it couldn't search as skipped. A `sync` of a path lists under
  `discarded` each workspace change it gave up for disk's state.
- **A workspace deletion stays deleted, and materialize never deletes from disk unasked.** Without
  `autoMaterialize`, a deleted file's disk copy is listed as `workspace-deleted` and no scan or
  lazy read brings it back. `materialize` lists the deletions it left on disk;
  `applyDeletions: true` removes those whose disk copy is still one the workspace held, and
  `force` too removes those changed since. A `sync` of the path restores the file.
  `autoMaterialize` writes and deletes follow materialize's freshness rule: a disk copy changed
  by another writer since it last agreed is refused, not overwritten or unlinked.
- **Undo and branch switches are not mistaken for disk edits.** What disk last agreed with is kept
  in global chronicle records rather than branch state, so selecting an earlier state keeps that
  state as a draft over the later disk version, and a file present only in another branch's
  history is listed `not-in-branch`, never ingested or unlinked. Every change of that evidence is
  written ahead of its disk write or tree adoption and completed after it is durable, so a crash
  or a torn record tail never costs an edit: the next observation decides by what disk shows (a
  disk copy matching neither outcome is an `interrupted` conflict), and a workspace write or
  deletion that shows on disk without proof it is durable is completed only by the next
  `materialize`, which redoes it. This replaces #109's stop-time baselines and refused paths,
  which an abrupt exit or a branch switch could lose or rewind; a store that saved them imports
  its baselines once.
- **`watch: 'on-agent-action'` works as documented:** after each completed tool batch, before
  anything continues the agent's turn, the mount is scanned. A scan that outlasts
  `agentActionScanDeadlineMs` stops holding the round and continues in the background; the miss
  is reported on `status` (`lastAgentActionScan`) and as a `workspace:agent-action-scan-incomplete`
  event, as are the regions a finished scan couldn't observe (`incomplete`).
- Disk text is stored as its raw bytes rather than through a UTF-8 round trip, so a file in
  another encoding no longer differs from its own stored copy.
- `materialize` and `autoMaterialize` check each write and unlink where it happens, not only when
  it is planned. A file is opened in its directory without truncating and located before any
  byte changes: never through a symlink the mount doesn't follow, or a directory that resolves
  outside the mount, and never into a file with other hard links, whose other names (a package
  store's, say) a write in place would change too, even with `force`. Unless `force`, it must
  also still hold what the materialize decided on, so a disk edit or a new file that appears
  meanwhile is refused, not overwritten. Refused paths are listed as skipped with the reason.
  Every directory from a written file up to the mount root is synced before the write counts as
  done, directories it had to create included. Listings likewise accept a directory's contents
  only while it is still the directory at its path. Each check is made where the operation
  happens, against what is there at that moment. Node has no `openat`, so a parent directory
  replaced concurrently in the window between a check and a create, `mkdir`, unlink or listing
  can still redirect that one operation: an empty file or directory can appear outside the
  mount, or a same-named file there can be unlinked. Content writes stay bound to the
  descriptor verified, inside the mount and with no other hard links, before modification; a
  hard link made to the file after that check shares the write.
