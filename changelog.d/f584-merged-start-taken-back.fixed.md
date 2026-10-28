- A wake the scheduler merged from several wakes and took back before its
  turn started (held by a provider's stated wait recorded after it was
  scheduled, or sent back from its wait for an auxiliary call by a quiesce or
  a turn still alive) is merged again from the wakes it took in, each as it
  was. It was merged again as one wake, which lost what its first merge had
  decided:
  - Merged from two or more deferred coalescing batches, it no longer counted
    as batch-only. When none of its batches had anything for it by then (each
    retracted, displaced, or taken by another agent's assembly), its turn
    called the model with nothing new to read, where the turn is withdrawn
    with `turn-withdrawn`.
  - It kept its first wake's time, so merged with a later-queued wake for an
    older message, such as a gate's batched wake, it gave the turn that
    message's channel instead of the newer addressed message's it stood for.
- A merged wake whose every wake is withdrawn while it waits starts no turn.
  If it is still waiting whole when the last of them goes and they were
  deferred batches, it traces `turn-withdrawn` naming them, with the stderr
  line `[coalescing] <agent>: its deferred batches were withdrawn while its
  wake waited; turn not started (no wake cause left)`.
  `HostModeStatus.gatedRequests` counts a merged wake as the wakes it took in.
- A provider hold whose kept wakes are all withdrawn while it holds them, as
  a deferred batch's wake is when the batch is retracted, now releases
  without starting a turn, with the stderr line `[provider-cooldown]
  agent=<agent> hold, its held wakes withdrawn, released after <ms>ms`. Its
  release queued a wake of its own (`provider-acceleration-retry`), whose
  turn called the model with nothing new to read.
