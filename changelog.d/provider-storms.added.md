- `inference:waiting` trace event: while an agent's turn waits before its
  next call, asleep in a capacity storm or on the wait its 529 stated
  (`reason: 'capacity-storm'`), or waiting out the error policy's retry
  delay, which a provider's stated wait can lengthen (`reason: 'retry'`),
  the framework emits it every 60 seconds with the agent's name and when the
  wait ends (`until`, left out for a wait with no end or one too far off to be
  a date), a storm's step that re-times the wait included, while
  the agent is still the one registered under its name. It never comes as a
  wait starts, since the failure's `inference:failed` has
  just gone out, and never after the wait ends, by its time coming, a
  release, an abort, a stop or the run's end. A host watching for agents
  gone quiet can tell a waiting one from a stuck one: connectome-host
  0.13.0's subagent reaper, which reclaims a subagent silent for two
  minutes, counts any trace naming it, so a subagent in a storm, or behind a
  stated wait over two minutes, is no longer reclaimed while it waits.
