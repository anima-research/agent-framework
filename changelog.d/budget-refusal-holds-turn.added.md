- **Hosts:** the trace events `inference:held`, as a turn starts waiting for
  compression, and `inference:hold_ended`, once, as the wait ends (#304,
  under Fixed), with `outcome` `released`, `stopped` or `removed`, and
  `waitedMs`. A turn that waits again has a new pair. `healthSnapshot().agents[].budgetHold`
  gives a waiting turn's `since`, compression's `pending` work, the waiting
  requests, and the refusal's type and figures, or `null`.
  `presentation:retracted` gains the reason `unsent-injection`, for the
  context injections no request carried, which leave the agent's window as
  a turn starts waiting.
- **Hosts and operators:** a waiting turn raises a `context-refusal` ops
  alert as it starts waiting, saying it waits for compression, once however
  often it waits again, unless a listener of `inference:held` has ended the
  wait first, and `context-refusal-clear` if it is stopped or removed while
  it waits, so the waiting start doesn't run, worded for which. It's the framework's first
  `-clear` kind. Both carry the wait's start as their webhook cooldown key,
  so each wait's pair reaches the webhook within the 15-minute cooldown,
  and neither writes failures.log. A refusal after the release goes to the
  error policy, and if the turn then exhausts, it raises its own
  `context-refusal`, as an exhausted turn's did before.
