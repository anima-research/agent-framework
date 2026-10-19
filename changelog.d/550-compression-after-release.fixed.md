- A context manager the framework is done with makes no provider call
  (#550): an ephemeral agent's once its run has ended or `cleanup()` has
  released it, and a conversation fork's once the fork has been disposed. A
  strategy that compresses in the background, as connectome-host builds a
  subagent's, went on calling the provider for whatever compression it still
  had queued, though no turn would compile that context again. That
  compression is now withdrawn unsent, and what was stored stays in the
  store. An ephemeral agent's compression is also withdrawn under a surgery's
  hold and once `stop()` has begun, as a resident's and a conversation
  agent's already were: before, it went on calling the provider while
  `stop()` tore down.
