- An ephemeral run whose turn's continuation the inference policy drops now
  rejects at once, with a plain `Error` naming the drop, as the turn ends.
  It used to wait for the idle watchdog, whose rejection said the run had
  stalled.
