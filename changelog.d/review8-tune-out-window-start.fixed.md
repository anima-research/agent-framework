- The persistent subconscious's window start, kept by index ordinal, stays where it is across a restart in three
  more cases. A kept start set at an enter or a restart was recorded as the start in force before it was set, so a
  set that threw left the strategy at the old start while the record named the new one, and a restart moved the
  window without an enter; it is now recorded once it is set, and a set or a keep that fails is tried again at the
  next presentation. A kept start clamped to a shorter window (after a rollback) is now kept at the clamped
  ordinal: before, a restart once more rows were presented set the old one, and the rows between left the window.
  And a restart that finds no start in force recorded (the oldest tune-out cancelled before its start was kept, a
  later one's start kept beside it) now keeps the window start the subconscious's strategy persisted where that is
  earlier than the oldest active tune-out's, rather than moving the window to the later start.
  `tune-out:subconscious-window` with `how: 'clamped'` is raised once the clamped start is set and kept.
