- **A message a tune-out holds is stored at once** (#291, #793's P1): it no longer waits in the deferred queue
  behind its target's live turn, as no write does now. No resident is shown it (the residents' view filter leaves it
  out, and the presentation index presents it to none), so it lands inside no request a resident's turn is shown,
  and its reader has it while the resident is busy: the persistent subconscious's view at its next wake, and a
  reader fork's framing, which names it by its stored id (`heldMessageIds`). As any write, it is kept in memory only
  while a surgery holds the store, until its release, or while the context manager of the agent it is written for
  refuses its work after a failed re-initialization, until a `switchBranch()` re-initializes it. Stored during its
  target's turn, it takes no clock row. A module's context reads such a message as the stored row it is, always
  with `heldFromResidents`, and with `held` for a read
  for a resident once that resident's window is written down (presented, not the whole record) and doesn't hold it:
  every held message stored since the audience stamp, which no resident's window takes in, but not one an earlier
  release stored, which a window written down from the record holds, its view leaving it out. A cancel's dump reads it
  from the record. While a surgery holds the store, a `check` counts and peeks the held messages the hold keeps in
  memory too (#232 gap 7); a cancel asked for then waits for the release, which stores them before the cancel runs
  (the deferral-queue entry), so a dump reads the hold's writes in memory only where the coordinator's `writesHeld`
  hook throws and the cancel goes on during the hold.
- A cancel the subconscious makes itself, with its note, gets it a report turn when some of its tune-out's stored
  messages are ones it hadn't been shown when it wrote the note (those its window doesn't hold); the notice says how
  many.
- `inspectAgentContext` on an ended agent reopens its context with the view its live one had: a resident's leaves
  out the other residents' stored context injections as well as held traffic, and the subconscious's leaves out
  the residents' stored injections. Before, they compiled them.
- The subconscious's window anchor counts an active all-except hold when a channel's tune-out is entered during it,
  so the anchor stays at the hold's start rather than moving forward past it.
