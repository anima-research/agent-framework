- **`workspace--status` for one mount that isn't direct shows its root's
  identity**, whether or not a sync can use the root: `root` carries
  `recorded` and `now` (`recorded` left out where the store's record of disk
  can't be read back), each its device and inode and, where it has one, its
  birth time as an ISO time in UTC to the nanosecond, so whoever upgraded
  can see whether the root's birth time was recorded. Where the root is
  usable and nothing is recorded yet, or no birth time is while the
  directory has one, `root.note` says so, what can pass as the root until
  then, and which call records it (a read-only mount's names no materialize,
  which writes nothing there); while the store awaits reopening it says
  nothing. Where the store's record of disk can't be read back, `status` for
  a mount with no files still answers, as it did, its `root` saying the
  recorded root can't be read, why, and the step that reopens the store.
  `status` for every mount reads no disk: it carries `root` only where the
  mount's last pass couldn't use the root, with `unavailable`, the words
  that pass listed, and `lastPassAt`, when it ran, and none where the last
  pass used it or no pass has run since start.
