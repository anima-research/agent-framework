- A context manager the framework is done with makes no further provider
  call, and none of its work runs after a store the framework owns closes
  (#550). From an ephemeral agent's run's end or its `cleanup()`, and from a
  conversation fork's disposal, its manager's new compression calls are
  withdrawn unsent, and the calls it has out are aborted, so membrane
  doesn't retry them. An ephemeral agent's new calls are withdrawn under a
  surgery's hold and once `stop()` has begun too, as a resident's and a
  conversation agent's already were; a call already out then runs on, as
  theirs do, until `stop()` closes a store the framework owns. Before, a
  strategy that compresses in the background, as connectome-host builds a
  subagent's, went on calling the provider in each of those cases, and a
  call still out when `stop()` closed the store answered into the closed
  store. `stop()`, with a store it owns, closes every manager it opened
  that's still alive, residents', the subconscious's and released ones
  included (`ContextManager.close()`), before it closes the store, so work a
  release left unwinding reads nothing of the closed store. A failed
  `create()` closes the managers it opened, whoever owns the store, and a
  fork or an ephemeral agent whose creation fails after its manager opened
  has that manager closed. A released manager stays open until then, as
  before, so its window still takes the writes held for it and a compile of
  it works. On a released manager whose strategy asks the provider for its
  transition text, as the autobiographical strategy does,
  `resetHeadWindow()` with no text rejects with an error that is an instance
  of context-manager's `CompressionWithdrawn`. With a store the host owns,
  `stop()` leaves the managers open.
- `cleanup()` is final: `runEphemeralToCompletion` refuses an agent it has
  released, saying so. Before, a run after `cleanup()` ran, with nothing
  said. A host that keeps a context manager after `stop()` with a store the
  framework owns, and does strategy work on it, gets, by our reading of
  context-manager 0.22.1, its "after close()" error, where it met a closed
  store.
