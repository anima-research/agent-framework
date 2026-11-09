- **Hosts:** the trace events `inference:held`, as a turn starts waiting for
  compression, and `inference:hold_ended`, once, as the wait ends (#304,
  under Fixed), with `outcome` `released`, `stopped` or `removed`, and
  `waitedMs`. A turn that waits again has a new pair. `healthSnapshot().agents[].budgetHold`
  gives a waiting turn's `since`, compression's `pending` work, the waiting
  requests, and the refusal's type and figures, or `null`.
  `presentation:retracted` gains the reason `unsent-injection`, for the
  context injections no request carried, which leave the agent's window as
  a turn starts waiting. `Agent` gains `unsentInjectionRows()`, the ids of
  its stored injections no request has carried, and two methods marked
  `@internal` for the framework's budget holds, `contextSettingsChanges()`
  and `markUnsentPoint()`.
- **Hosts and operators:** a waiting turn raises a `context-refusal` ops
  alert, saying it waits for compression, once however often it waits
  again: as it starts waiting, or, where a listener of `inference:held`
  ended that hold first, as it next waits. Once that alert is raised, it
  raises `context-refusal-clear` if it is stopped or removed while it
  waits, so the waiting start doesn't run, worded for which. It's the
  framework's first `-clear` kind. Both carry the wait's first start as
  their webhook cooldown key, so each wait's pair reaches the webhook
  within the 15-minute cooldown, and neither writes failures.log. The
  clear's `waitedMs` and the note count from that first start too, while a
  wait held again starts a new hold, whose `inference:held`,
  `inference:hold_ended` and health snapshot give that hold's own start. A refusal after the
  release waits again while compression is pending; with nothing pending
  it goes to the error policy, and if the turn then exhausts, it raises its
  own `context-refusal`, as an exhausted turn's did before.
