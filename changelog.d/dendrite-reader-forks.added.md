- `subconscious.reader: 'forks'` (Dendrite): the tune-out reader as a succession
  of forks of the resident instead of one persistent side-agent. Each cadence
  tick, coalesced wake and cancel derives a short-lived `subconscious-fork` at
  the resident's head — its history as the fork's own turns, its refusal ledger,
  its tools and system prompt, ending with it — hands it the traffic held since
  the last look as ordinary framing (each held message to exactly one fork, media
  preserved), and lets it report through `deliver_summary` as attributed mail
  under the fork's name and incarnation. `subconscious.strategyFactory` supplies
  a fresh strategy instance for each fork (required for a folding resident);
  `subconscious.forkIdleTimeoutMs` bounds one fork (default 10 minutes). A fork
  runs on the resident's model: a different `subconscious.model` is refused at
  `create`. New trace `tune-out:reader-fork`. `reader: 'persistent'` remains the default and
  is unchanged.
