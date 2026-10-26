- The presentation index (#291): each agent's context follows its own window, the rows it was shown in the order
  its requests carried them, kept by context-manager (`presentRows`) beside the store's record. Every framework
  constructs the index's module, which needs a context-manager with `ContextManager.presentRows` (create() refuses
  one without it), and runs its presentation points (see the entry for what they do). It checks each write's
  audience stamp, and a write stamped only for agents none of whom reads the slot it is stored in is traced as
  `presentation:unreadable-audience` and stored as named. The trace types the index will emit are in
  `TraceEvent` now: `presentation:presented`, `presentation:repaired`, `presentation:unreadable-audience`,
  `presentation:failed`, `presentation:hand-off-mismatch`, `presentation:retracted` and `window:undone`.
- `observedRowFor(edge, row, { observer, owners })`: what an observe edge shows of the slot it reads (#291, decision
  1). Another agent's stored context injection, and a row stored under the observer's own name, never; a held row
  only through an edge with `includeHeld`; a row with no audience stamp, an owner's own row and a row whose audience
  names an owner, yes; anything else, no.
- The own-row sink the presentation index presents an agent's own rows through, as they are written:
  `Agent.setOwnRowSink(sink)` and `Agent.ownRowsStored(ids)`, `OwnRowWriter.ownRowsStored?(ids)`, and a `present`
  argument on `storeOwnRow` (default true; `false` stores the row without telling the sink, for a row written where
  a turn it isn't part of may be alive). The index installs it for each agent it takes on.
