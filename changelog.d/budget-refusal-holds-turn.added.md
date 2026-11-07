- **Hosts and operators:** an ops alert kind, `context-hold`, raised each
  time a turn goes into a budget hold (#304, under Fixed): a fresh hold, or a
  released turn whose start is refused again. Its clear, `context-hold-clear`,
  is raised at every end of that hold: a release, a hold that ends because
  compression had nothing left to do, and one ended with its turn, by a stop,
  an abandon, `abortInference()` or a disposal. So starts and clears pair one
  to one, and a request that joins a held turn raises neither. It's the
  framework's first alert kind with a clear.
  - **Its words:** the turn is held until compression makes room, the
    refused compile's reason, bounded so the whole stays within 2,000
    characters, and the way on that a surgery's refusal names, a quiesce with
    `abandon: true`. Its data carries the refusal's type and figures, and when
    the hold began. The clear's words say how the hold ended and what the
    turn does next; its data carries the outcome, how long the hold lasted,
    and, for a check that failed, the check's error.
  - Neither is written to failures.log. Both post to the ops webhook at
    every transition, outside the cooldown that thins a repeating failure's
    posts: sent start then clear, each a post of its own, which a webhook may
    receive out of order. The `ops:alert` trace is the ordered record: a
    listener of either alert that ends the hold at once still sees the start,
    then `inference:held`, then the end and its clear, in that order.
  - A host that maps alert kinds to where it posts them needs an entry for
    `context-hold` to post it; one that treats an unlisted kind as silent
    posts nothing for it.
- **Modules and hosts:** `Agent.nextCompileBudget()`, the budget the agent's
  next compile plans at: its configured budget with the tool-result guard's
  pending reserve, or context-manager's own default when it sets none. The
  default it returns is frozen.
