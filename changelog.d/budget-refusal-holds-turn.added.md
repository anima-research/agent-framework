- **Hosts:** the trace events `inference:held`, as a turn starts waiting for
  compression, and `inference:hold_ended`, once, as the wait ends (#304,
  under Fixed), with `outcome` `fit`, `nothing_pending`, `failed`, `stopped`
  or `removed`, and `waitedMs`. `healthSnapshot().agents[].budgetHold`
  gives a waiting turn's `since`, compression's `pending` work, the waiting
  requests, and the refusal's type and figures, or `null`.
- **Hosts and operators:** a waiting turn raises one `context-refusal` ops
  alert as it starts waiting, saying it waits for compression, and
  `context-refusal-clear` if the wait ends without the turn running, worded
  for how it ended. It's the framework's first `-clear` kind. Both carry the
  wait's start as their webhook cooldown key, so each wait's pair reaches
  the webhook within the 15-minute cooldown, and neither writes
  failures.log.
