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
  since.
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
  or a torn record tail resolves at the next observation (a disk copy matching neither outcome is
  an `interrupted` conflict). This replaces #109's stop-time baselines and refused paths, which
  an abrupt exit or a branch switch could lose or rewind; a store that saved them imports its
  baselines once.
- **`watch: 'on-agent-action'` works as documented:** after each completed tool batch, before the
  agent's next inference, the mount is scanned. A scan that outlasts `agentActionScanDeadlineMs`
  lets the inference go ahead and is reported on `status` and as a
  `workspace:agent-action-scan-incomplete` event.
- Disk text is stored as its raw bytes rather than through a UTF-8 round trip, so a file in
  another encoding no longer differs from its own stored copy.
- `materialize` and `autoMaterialize` never write or unlink through a symlink the mount doesn't
  follow, or through a directory that resolves outside the mount, even with `force`; such a path
  is listed as skipped with the reason.
