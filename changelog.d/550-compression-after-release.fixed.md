- A context manager the framework is done with starts no further provider
  call (#550): an ephemeral agent's once its run has ended or `cleanup()`
  has released it, and a conversation fork's once the fork has been disposed
  or has failed partway through being made. A strategy that compresses in
  the background, as connectome-host builds a subagent's, went on calling
  the provider for whatever compression it still had queued, for a run that
  had ended or that its caller had given up on. That compression is now
  withdrawn unsent, and what was stored stays in the store. A call already
  out runs to its answer, its retries inside membrane included. On such a
  manager, `resetHeadWindow()` with no transition text, which would ask the
  provider for one, now rejects with an error that is an instance of
  context-manager's `CompressionWithdrawn`; with text it works as before. An
  ephemeral agent's compression is also withdrawn under a surgery's hold and
  once `stop()` has begun, as a resident's and a conversation agent's
  already were: before, it went on calling the provider while `stop()` tore
  down.
- `cleanup()` now also retires an ephemeral agent that hasn't run:
  `runEphemeralToCompletion` refuses it at admission, saying so. Before, a
  run after `cleanup()` ran, with nothing said.
