- The Discord module doesn't pass over a message whose create was lost at a surgery's release (a create the hold
  kept in memory, whose store threw at the release with no row landed). The release traces the lost write
  (`message:lost`), and the module ends its record of that create, with the edits or delete kept for it, so a later
  delete of the message, a history sync and a live create of it aren't left waiting on a row that never comes: the
  next sync stores the message and its delete reaches that row.
- A kept create whose release can't tell whether it landed (`message:lost` with `mayBeStored`, no row named
  stored), though its row has landed, gets the edits or delete kept for it, though no `message:added` comes for the
  row, so the store doesn't keep the original text, or a deleted message.
- A definite loss (`message:lost` without `mayBeStored`) ends the module's record of the create with no store read,
  so a read that throws can't keep the entry waiting for a row that never comes.
- Where the read that looks for such a create's row throws, the entry waits with what was kept for it, and the next
  Discord event's sweep applies the edits or delete to the row it finds before it ends the entry.
