- A turn whose continuation (a budget restart's, or a tool-result guard's
  retry) is waiting to start now counts as alive. Between the turn's stream
  ending and the continuation's start, a stretch that a provider wait stated
  meanwhile makes as long as the wait, the host used to report `drained`, a
  `quiesce()` returned drained and the continuation then started while the
  host was quiesced, and `quiesce({ abandon: true })` found nothing to end.
  Now `activeTurnAgents` lists the agent, a `quiesce()` waits for the
  continuation's turn, and an abandon ends the turn with the continuation
  dropped. A puppet tool call and a branch switch are refused in that
  stretch, as during any live turn.
- A turn whose continuation is dropped by an abandon, `stop()`, the
  inference policy, the agent's removal or a conversation agent's disposal
  now ends. It writes one `inference:aborted`, releases the EventGate window
  it held for the continuation, closes its logical turn and stops its
  typing, and the tool-result guard's pending batch is withheld from later
  requests, as for a turn that ends before it sends anything. A provider
  hold left empty by the drop releases without queueing a retry turn. An
  ephemeral run that ends takes such a continuation with it, its own end
  having ended the turn.
