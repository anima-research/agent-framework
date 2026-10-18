- **Two operator changes of one kind made one after the other within a
  millisecond each get a branch.** Unless the caller names it, a suppression,
  a rollback, the host command's message undo, a turn undo and an offline
  recovery name the branch they make for the time in milliseconds
  (`suppress/<agent>/<ms>` and so on). A second change of the same kind in the
  same millisecond used to be refused, because its name was the first one's
  branch. A default name is now one the store doesn't hold: the timestamped
  name, or that name with `-2`, `-3`, … appended. A name the caller gives is
  used as given, and the store still refuses one that's taken.
