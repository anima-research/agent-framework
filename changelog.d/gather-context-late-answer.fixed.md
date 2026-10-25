- **A module's `gatherContext()` that answers after its timeout adds
  nothing,** and no longer prints the line about blocks the system prompt
  can't carry. It was still pushed into the list the registry returns for
  the turn. When another module was still being waited for, it landed there
  before the list was returned, so it reached the turn's request. Otherwise
  it landed afterwards, and when another module had answered in time, a
  turn for an agent that isn't a conversation fork keeps that list while it
  waits for MCPL servers' `beforeInference`, so a late answer arriving
  during that wait reached the request too.
- **A module whose `gatherContext()` throws before returning a promise is
  skipped,** logged as a module that rejects is. The throw left the
  registry's `gatherContext()`, and the turn then went without every
  module's injections. A module whose `gatherContext()` returns an array
  without a promise has it taken as its answer, where it lost every module's
  injections the same way. One that answers with something other than an
  array is skipped and logged, where a string answered through a promise
  was spread into the turn's injections one character each.
