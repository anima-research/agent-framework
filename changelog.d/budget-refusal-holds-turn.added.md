- **Hosts and operators:** an ops alert kind, `context-hold`, raised when a
  turn goes into a budget hold (#304, under Fixed). Its clear,
  `context-hold-clear`, is raised when the hold's episode ends: a released
  turn's start gets past its compile; the turn ends, held or released, by a
  stop, an abandon, `abortInference()` or a disposal; a provider hold takes
  the released turn; or the hold ends because compression had nothing left
  to do, or a released turn's start is refused again with nothing left for
  it to do, and the error policy takes the refusal. A released turn whose
  start is refused again while compression is pending is held again in the
  same episode: its release raises no clear, and its new hold no
  `context-hold`. So a held turn raises one start and one clear however
  often it's released and held again, unless a provider hold takes it
  between, which ends the episode, so that a budget hold after it raises
  another pair. A request that joins a held turn raises neither, and
  `inference:held` and `inference:hold_ended` mark each hold and each end.
  It's the framework's first alert kind with a clear.
  - **Its words:** the turn is held until compression makes room, the
    refused compile's reason, bounded so the whole stays within 2,000
    characters, and the way on that a surgery's refusal names, a quiesce with
    `abandon: true`. Its data carries the refusal's type and figures, and when
    the hold began. The clear's words say how the hold ended and what the
    turn does next; its data carries the outcome, how long the hold lasted,
    and, for a check that failed, the check's error.
  - Neither is written to failures.log. Both post to the ops webhook,
    outside the cooldown that thins a repeating failure's posts: the start
    as the hold begins and the clear as the turn leaves it, each a post of
    its own, which a webhook may receive out of order. The `ops:alert` trace
    is the ordered record: a listener of `context-hold` that ends the hold at
    once still sees the start, then `inference:held`, then the end and its
    clear, in that order.
  - A host that maps alert kinds to where it posts them needs an entry for
    `context-hold` to post it; one that treats an unlisted kind as silent
    posts nothing for it.
- **Modules and hosts:** `Agent.nextCompileBudget()`, the budget the agent's
  next compile plans at: its configured budget with the tool-result guard's
  pending reserve, or context-manager's own default when it sets none. The
  default it returns is frozen.
