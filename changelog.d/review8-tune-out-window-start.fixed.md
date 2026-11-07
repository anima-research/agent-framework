- The persistent subconscious's window start, kept by index ordinal, stays where it is across a restart in these
  cases too. A kept start set at an enter or a restart is recorded as the start in force once it is set, so a set
  that throws doesn't leave the record naming a start the strategy isn't at, for a restart to move the window to
  without an enter; a set or a keep that fails is tried again at the next presentation. A kept start clamped to a
  shorter window (after a rollback) is kept at the clamped ordinal, so a restart once more rows are presented
  doesn't set the old one and take the rows between out of the window. A restart that finds no start in force
  recorded (the oldest tune-out cancelled before its start was kept, a later one's start kept beside it) keeps the
  window start the subconscious's strategy persisted where that is earlier than the oldest active tune-out's,
  without moving the window to the later start. A restart that finds no start kept for the oldest active tune-out
  either (its start fixed and set, the write keeping it failed) keeps the start the strategy persisted, since
  working the start out again from the tune-out's sequence gives another window once rows have been presented out
  of record order; that tune-out's own start is fixed beside it, without moving the window to it.
  `tune-out:subconscious-window` with `how: 'clamped'` is raised once the clamped start is set and kept.
