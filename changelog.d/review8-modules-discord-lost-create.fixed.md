- The Discord module no longer passes over a message whose create was lost at a surgery's release. A create the
  hold kept in memory, whose store threw at the release with no row landed, left the module's record of it
  waiting for a row that never came, for the lifetime of the module: a later delete of the message was answered
  with nothing, and a history sync and a live create of it kept skipping it. The release now traces the lost write
  (`message:lost`), and the module ends its record of that create, with the edits or delete kept for it, so the
  next sync stores the message and its delete reaches that row.
