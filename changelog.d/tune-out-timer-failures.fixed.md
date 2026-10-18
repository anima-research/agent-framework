- A tune-out's cadence, coalesced wake or end time whose work throws, such
  as a store write that fails during the subconscious's turn, no longer
  throws into the event loop, where an uncaught exception ends the host
  process. The coordinator writes the error to stderr and reports a
  `tune-out:timer-failed` trace naming the timer. Before, a cadence whose
  turn threw also never armed again. Now it arms its next period before
  the turn, and that next turn counts the failed turn's messages. An end
  time whose cancel throws before the channel registry has changed
  anything tries the cancel again a minute later, until it succeeds.
- A failed acknowledgement of a suppressed mention is written to stderr
  as well as traced, and a rejection with `undefined` or `null` no
  longer throws inside its handler.
