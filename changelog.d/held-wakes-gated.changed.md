- `HostModeStatus.gatedRequests` also counts a wake a provider hold keeps:
  an acceleration or host hold, or a provider's stated wait. Before, it
  counted only wakes parked by the quiesce gate or queued, so a wake held
  while no turn was alive showed nowhere in the status, and a host that
  reads `gatedRequests` beside `drained` to decide the agent is idle
  answered while the wake waited for the hold to end. That happens when a
  host's `providerHold` holds after a failed compression, when a provider's
  stated wait on the agent's model holds a wake (one a failed compression on
  that model records, for example), or when a stop drops a turn's retry
  from a hold that then keeps a later wake. A wake held beside a turn's
  retry is counted too; the retry still counts as the turn alive, in
  `activeTurns`, and not here. `drained` is unchanged: it counts turns
  alive, and a hold that releases during a quiesce leaves its wake parked at
  the quiesce gate.
