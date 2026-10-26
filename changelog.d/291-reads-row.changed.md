- Once an agent's context presents rows (#291), what it has read is what its
  window held as of its mark: a row stored and not yet presented to it is
  unread, whatever the store's head was, and so is a row presented to
  another agent alone. A row the presentation index says a window holds is
  read by that window's agent too. The coalescer takes back a row no reader
  consumed, presented to a window or not, as it took back a queued one, and
  the row leaves every window that held it; it keeps a row a reader fork
  was handed as framing, and places the newer occurrence after it. A
  released fork's or run's notice it never had in its window as of its mark
  goes on to the primary, and one whose mark a branch switch left behind
  goes on whatever it read. The gate's "newest entry", the next clock row
  and the drafts catch-up read the window's order: a co-resident's rows in
  the shared slot aren't in it, and a drafts notice taken out as an undone
  turn's doesn't count.
