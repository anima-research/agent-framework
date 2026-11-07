- **A message a tune-out holds is stored at once** (#291, #793's P1), as every write now is, instead of waiting in
  the deferred queue behind its target's live turn. No resident is shown it, so it lands inside no request a
  resident's turn is shown, and its reader has it while the resident is busy: the persistent subconscious's view at
  its next wake, and a reader fork's framing, which names it by its stored id (`heldMessageIds`). A module's context
  reads it as the stored row it is, always with `heldFromResidents`, and with `held` for a read for a resident whose
  window is written down and doesn't hold it: every held message stored since the audience stamp, but not one an
  earlier release stored, which a window written down from the record holds, its view leaving it out. A cancel's
  dump reads it from the record. While a surgery holds the store, a `check` counts and peeks the held messages the
  hold keeps in memory too (#232 gap 7).
- A cancel the subconscious makes itself, with its note, gets it a report turn when some of its tune-out's stored
  messages are ones it hadn't been shown when it wrote the note (those its window doesn't hold); the notice says how
  many.
- `inspectAgentContext` on an ended agent reopens its context with the view its live one had: a resident's leaves
  out the other residents' stored context injections as well as held traffic, as in 0.32.0, and the subconscious's
  leaves out the residents' stored injections and keeps the held traffic it reads. 0.32.0 reopened an ended
  subconscious through the residents' view, which left out held traffic as well (and on the residents' slot: see
  Fixed: an ended subconscious that `inspectAgentContext` reopens).
- The subconscious's window anchor counts an active all-except hold when a channel's tune-out is entered during it,
  so the anchor stays at the hold's start rather than moving forward past it.
