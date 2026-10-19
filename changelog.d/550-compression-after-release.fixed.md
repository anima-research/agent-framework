- A context manager the framework is done with makes no further provider
  call (#550): an ephemeral agent's once its run has ended or `cleanup()`
  has released it, and a conversation fork's once the fork has been disposed
  or has failed partway through being made. A strategy that compresses in
  the background, as connectome-host builds a subagent's, went on calling
  the provider for whatever compression it still had queued, though no turn
  would compile that context again. That compression is now withdrawn
  unsent, while a call already out runs to its answer, and what was stored
  stays in the store. On such a manager, `resetHeadWindow()` with no
  transition text, which would ask the provider for one, now rejects with a
  `MaintenanceWithdrawnError`, which extends context-manager's
  `CompressionWithdrawn`; with text it works as before. An ephemeral agent's
  compression is also withdrawn under a surgery's hold and once `stop()` has
  begun, as a resident's and a conversation agent's already were: before, it
  went on calling the provider while `stop()` tore down.
