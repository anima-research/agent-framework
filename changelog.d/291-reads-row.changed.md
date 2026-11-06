- Once an agent's context presents rows (#291), what it has read is what its
  window held as of its mark: a row stored and not yet presented to it is
  unread, whatever the store's head was, and so is a row presented to
  another agent alone. A row the presentation index says a window holds is
  read by that window's agent too. The coalescer takes back a row no reader
  consumed, presented to a window or not, as it took back a queued one, and
  the row leaves every window that held it; it keeps a row a reader fork was
  handed as framing, and places the newer occurrence after it. A released
  fork's or run's notice for it that it never had in its window as of its
  mark goes on to the primary, and one whose mark a branch switch left
  behind goes on whatever it read. A notice is for it when its audience
  names it, or, with no stamp, when it was stored after a shared fork's
  derivation point: a notice in the record a shared fork or a resident
  shares, for its parent or a co-resident, is that agent's, and no release
  of another passes it on. The gate's "newest entry", the next clock row and
  the drafts catch-up read the window's order: a co-resident's rows in the
  shared slot aren't in it, and a drafts notice taken out as an undone
  turn's doesn't count.
- A wake for a row stored for its agent carries `InferenceRequest.readsRow`
  (the row's stored id) whether or not the row was presented to that agent
  at its write, not only for a row kept out of its window while its turn
  was alive: #814's mark for a message stored as it arrived (0.28.0's
  entry for it), read onto the presentation index. The wake is
  dropped only once an answered request carried the row, which that
  request's mark says by the row's place in the agent's window, or once
  the row is gone from the agent's store on its current branch (removed,
  or left on a branch it has moved from), so a request that never carried
  a stored row keeps its wake. A resumed turn (a
  context-budget restart, or a tool-result guard's retry a provider held)
  presents nothing that arrived meanwhile, so such a row's wake still starts
  its turn. A conversation fork's channel message, routed to it or delivered
  to it by name (`deliverTo`), marks the fork's wake the same way, and one its
  server tagged `chat:ambient` marks it ambient, as a resident's, so it asks
  no answer in its channel. A gate batch's `[Gate: …]` line, stored with its
  batch, marks the delivery agent's wake with its row, as the self-wake's
  notice does; other agents' wakes for the batch stay plain.
