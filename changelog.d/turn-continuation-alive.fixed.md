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
- A turn whose continuation is dropped now ends: by an abandon, `stop()`, the
  inference policy, the agent's removal or a conversation agent's disposal.
  It writes one `inference:aborted`, releases the EventGate window it held
  for the continuation, closes its logical turn and stops its typing. A
  provider hold left empty by the drop releases without queueing a retry
  turn.
