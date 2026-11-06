- The Discord module no longer passes over a message whose create was lost at a surgery's release. A create the
  hold kept in memory, whose store threw at the release with no row landed, left the module's record of it
  waiting for a row that never came, for the lifetime of the module: a later delete of the message was answered
  with nothing, and a history sync and a live create of it kept skipping it. The release now traces the lost write
  (`message:lost`), and the module ends its record of that create, with the edits or delete kept for it, so the
  next sync stores the message and its delete reaches that row.
- A kept create whose release couldn't tell whether it landed (`message:lost` with `mayBeStored`, no row named
  stored), though its row had landed, now gets the edits or delete kept for it: no `message:added` came for the
  row, so the module found it and left the entry to the next Discord event, whose sweep ended it with the edit or
  delete never applied, leaving the original text, or a deleted message, in the store.
- A definite loss (`message:lost` without `mayBeStored`) ends the module's record of the create with no store read:
  a read that threw kept the entry waiting for a row that never comes, and history syncs and creates of the
  message passed it over until the module stopped.
