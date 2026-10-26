- **A message a tune-out holds is stored at once** (#291, #793's P1), flag on or off: it no longer waits in the
  deferred queue behind its target's live turn. No resident is shown it (the residents' view filter leaves it out,
  and the presentation index presents it to none), so it lands inside no request a resident's turn is shown, and
  its reader has it while the resident is busy: the persistent subconscious's view at its next wake, and a reader
  fork's framing, which names it by its stored id (`heldMessageIds`). A quiesce and a surgery's hold still queue
  it, as they queue any write, and a held message arriving while one is still queued for its target waits behind
  it, so held messages are stored in the order they arrived. Stored during its target's turn, it takes no clock
  row. A module's context reads such a message as the stored row it is (no `held`, with `heldFromResidents`), and
  a cancel's dump reads it from the record.
- A cancel the subconscious makes itself, with its note, gets it a report turn when some of its tune-out's stored
  messages are ones it hadn't been shown when it wrote the note (with the presentation index, those its window
  doesn't hold; else those stored after its last compile); the notice says how many.
- `inspectAgentContext` on an ended agent reopens its context with the view its live one had: a resident's leaves
  out the other residents' stored context injections as well as held traffic, and the subconscious's leaves out
  the residents' stored injections. Before, they compiled them.
- The subconscious's window anchor counts an active all-except hold when a channel's tune-out is entered during it,
  so the anchor stays at the hold's start rather than moving forward past it.
