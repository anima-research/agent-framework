- The workspace's reasons for what a push, a sync, a listing or a read
  couldn't do now give the way on, or say who can fix it:
  - A failed system call is said in plain words, with what helps: an
    unlink's failure no longer quotes Node's message with the host's path,
    and a code in parentheses became words.
  - A push that failed after it began writing or unlinking, or whose
    durability barrier failed, says that whether disk holds the change isn't
    known until it's checked, and that a materialize of the path checks it
    and says how it ended.
  - What stands at a push's path or on its way, such as a symlink this mount
    doesn't follow, one leading out of the mount, a pipe, a link to a
    directory or a directory leading out of the mount, is named with what
    gets past it, forced or not. A disk copy a push couldn't verify names
    who can fix the cause. A reason that already names the path to use, a
    nested mount's place or a link's target, gets nothing added, where "fix
    it and materialize again" followed it before. A push of a file whose
    stored copy is lost names the read, which takes disk's copy where it
    can and otherwise says what can be done.
  - A symlink among a path's directories that the mount doesn't follow names
    the path to use where it leads to a directory inside the mount, and the
    mount whose `followSymlinks` whoever runs the host can set; says that
    nothing lies beneath one leading to something that isn't a directory;
    and says what gets past one leading nowhere or somewhere its refusal
    doesn't name. One leading outside the mount, or a path that leaves the
    mount through a symlink, says that nothing done through the mount
    reaches what it leads to, and that whoever runs the host can mount it,
    or a directory that holds it. A directory on the way that the walk
    can't ask gives its errno's way on. The tools quote the path they were
    given before the link's reason. A symlink at a path the mount doesn't
    follow says that whoever runs the host can set `followSymlinks` where it
    leads inside the mount, mount what it leads to, or a directory that
    holds it, where it leads outside, or remove it where it leads nowhere,
    where before it
    said to name the file it leads to by its own path, which the agent
    couldn't learn and which may lie in no mount.
  - `sync`'s skips, and the incomplete regions of `ls`, `sync`, `grep` and
    an agent-action scan, give a way on where the walk failed, met a
    change, found the root unavailable, met a link or a place leading out
    of the mount or a link to a directory, or reached its cap. A `sync`
    skip of a path its walk passed over, one the mount ignores, an editor's
    swap or backup file, or one beneath a link the walk doesn't enter,
    names the sync of that path, which checks it. A
    listing's per-entry notes and `grep`'s per-file skips stay
    descriptions.
  - A mount whose path holds a file where its directory was is told, as one
    whose directory is gone, that whoever runs the host can put the
    directory back. A region the walk cap left says that naming a path
    beneath it walks only that path, and that whoever runs the host can
    raise the mount's `walkCap`.
  - `read` of a file the workspace doesn't hold, where disk couldn't be
    checked, gives the way on its reason calls for, as a push or a sync
    gives it: an errno's, a symlink's, or that of a directory resolving
    outside the mount.
  - A direct mount's `delete` of a file that changed while it was checked
    says that calling again checks it afresh.
  - `save_recent_image`, where the store throws on a write, says the
    store's errno in plain words with a way on, and still names the images
    already saved. The error is logged whole, since an error it can't word
    that way sends whoever runs the host to the log.
- A forced `materialize` without `applyDeletions` lists a workspace
  deletion that no push makes, forced or not, such as one over or beneath
  a symlink this mount doesn't follow, under `skipped` with why, rather
  than among the deletions `applyDeletions` would make.
- **Hosts calling `readFileFromDisk`, `readBinaryFromDisk` or
  `writeBinary`, or reading a scan's `incomplete`:** codes are unchanged.
  The reason after `<path>: ` in a link refusal now ends with its way on:
  "the mount's host can set followSymlinks: true" became `use "<target>"
  in place of "<link>", or whoever runs this host can set followSymlinks:
  true on mount "<mount>"`. A `writeBinary` failure quotes the push's
  reasons in these words, and the `incomplete` reasons on `status`'s
  `lastAgentActionScan` and the `workspace:agent-action-scan-incomplete`
  event carry their way on, an errno in plain words. Code that matches on
  those words needs updating.
