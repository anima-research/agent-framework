- What was deferred for an agent before a coalesced render or message the
  agent's turn assembles now lands ahead of it, in the order it arrived. The
  assembly's write used to be stored at once, ahead of a write still queued
  for the agent, so a render could be read before the earlier render it
  builds on: after a render landed in the agent's queue during its own
  assembly, or after the turn's start couldn't store a queued render. When a
  queued write can't be stored, the assembled one now waits behind it. What
  is deferred for the agent while its assembly awaits a render, such as a
  render another agent's assembly placed in its queue, now lands in that
  turn's request, rather than at the turn's first tool boundary or its end.
- A render's wake to read it, given when the render lands in an agent's
  deferred queue, no longer starts a turn if, when the scheduler comes to
  start it, the agent has already read the render or the render was
  retracted.
- A provider hold no longer keeps two wakes from the same millisecond as
  one when one of them is a coalesced batch's wake or a wake to read a
  render, so withdrawing the batch, or dropping the read render's wake,
  no longer takes the other wake's cause with it.
- A reply to a `[Continue]` turn that a coalesced batch's wake or a wake to
  read a render started now keeps its `promptedBy` stamp, so later
  requests render `[Continue]` before it as they do for other such replies.
- A render that settles after its turn's assembly has failed, while the turn
  is still alive, is now deferred like any other write during the turn,
  rather than stored into the turn after its compile. While the host is
  quiesced, the assembly's writes wait behind what is queued for the agent,
  and land when it does.
