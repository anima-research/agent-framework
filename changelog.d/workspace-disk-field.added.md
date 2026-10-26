- The answers of `write`, `edit`, `edit_many` and `delete`, and a
  `WorkspaceModule.writeBinary` success, carry `disk`: where the change
  stands on disk as the workspace last saw it, since the call doesn't read
  disk. `done` means nothing of it waits: the call wrote it there, on a
  direct mount or through `autoMaterialize`'s push, or disk already agreed
  with it, or a deletion found no disk copy of the workspace's to remove.
  `waits for materialize` means a materialize writes it, and
  `waits for materialize with applyDeletions` means a deletion takes a
  materialize with that option, since one without it leaves the file.
  `in conflict with disk` means an unforced materialize leaves the path, which
  a sync or a forced materialize settles. In `edit` and `edit_many` it's a
  header line, and `edit_many` gives the value of its file furthest from disk.
  Each file `save_recent_image` saves carries it too, or `diskCopyError` where
  the file's disk copy failed. Before, on a store-backed mount without
  `autoMaterialize`, these answers read the same as where the change was
  already on disk.
