- `HostModeStatus.gatedRequests` counts every inference request waiting to
  start, wherever it waits: queued, in a scheduler pass's hands, or held by
  a provider hold (an acceleration or host hold, or a provider's stated
  wait). There, a start that carries a turn on counts as the wakes merged
  into it. What a quiesce lets through, a turn's continuation or its held
  retry, still isn't counted. Before, it counted only queued requests, and
  no wake merged into a start, so a wake a hold kept while no turn was alive
  showed nowhere in the status. A host that reads `gatedRequests` beside
  `drained` to decide an agent is idle answered while the wake waited for
  the hold to end. That happens when a host's `providerHold` holds after a
  failed compression, when a provider's stated wait on the agent's model
  holds a wake (one a failed compression on that model records, for
  example), or when a stop drops a turn's retry from a hold that then keeps
  a later wake. Such a host's idle check now waits for the hold to end,
  however long the provider's stated wait, or until an operator releases a
  wait with no end. `drained` is unchanged: it counts turns alive, and a
  hold that releases during a quiesce hands its wakes to the quiesce gate,
  as any queued wake meets it, so no turn starts until `resume()`. The
  quiesce's log line says "wake(s) waiting" where it said "wake(s) parked".
