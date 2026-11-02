- **Hosts and operators:** a turn held for its context budget (#304, under
  Fixed) is a turn alive until it runs or ends, as a turn a provider hold
  keeps for its retry is. Before, the refused compile ended the turn within
  seconds.
  - `getHostModeStatus()` reads `drained: false` while it waits and lists the
    agent in `activeTurnAgents`, and wakes that join it count in
    `gatedRequests`. A quiesce waits for it: once the hold releases it, the
    turn starts and finishes, as any turn alive at the quiesce does, while the
    wakes that joined it wait for `resume()`. A hold has no time limit, so a
    quiesce made while a turn is held drains only if the turn ends within the
    quiesce's window: released and finished, or ended by `abortInference()`. A
    quiesce with `abandon: true` ends it, as do `abortInference()`, `stop()`
    and a conversation agent's disposal, each with one `inference:aborted`.
    After an abandon or `abortInference()`, the wakes that joined it go back
    to the queue and run as a turn of their own.
  - A surgery, a branch switch, and an undo or redo that would move the store
    are refused (`agent-busy`) while a turn is held, for every agent sharing
    the store, not only the held one, as the store-wide surgery gate refuses
    them while a provider hold keeps a turn's retry; and so is
    `puppetToolCall` for the held agent. The refusal names the hold and its
    reason, and says that a quiesce with `abandon: true` ends the turn. A host
    that ran surgery on a resident whose turn had ended on such a refusal now
    waits for the hold, however long it lasts, or ends the turn.
  - The turn's terminal event comes when the held turn ends, however long it
    was held, rather than as an exhaustion within seconds. Wakes that arrive
    while it waits join it: the held list has no bound, and how large a long
    wait makes it hasn't been measured. The refused attempt emits
    `inference:failed`, as an attempt a provider hold keeps does, and then the
    new trace `inference:held`; `inference:hold_ended` follows when the hold
    ends, and the turn's next start emits `inference:started` again.
    `healthSnapshot()` gives each agent's `budgetHold` (or null).
  - A held turn raises no ops alert, since it goes on. Before, the refused
    compile's exhaustion raised `context-refusal`; a hold that ends without a
    fit and whose turn's compile is refused again still does. The hold's start
    logs a `[budget-hold]` line, unless an `inference:held` listener has
    already ended it, saying the turn runs once a check finds its context fits
    its budget, followed by context-manager's own description of its pending
    work, and a turn held again after a release logs a line saying so. A
    compression call that fails in a tick the hold drives is reported as one
    that fails in a maintenance pass is, as `context-maintenance-failed` for
    the agent, under maintenance's rule for repeats; a drive that ends without
    a failure counts as a pass without one. The hold's first drive of
    compression logs a `[budget-hold]` line with its tick count unless a call
    fails in it, and a later drive logs one only when it stops early.
- **Agents:** the turn's next start once its hold ends, with a fit or without,
  stores a note in the agent's history saying why it waited, where the turn
  reads it, as an `afterUser` context injection is stored (while the window is
  held, the compile places it instead): "[budget-hold] Your context didn't fit
  its budget (100,201 tokens against 48,568), so this turn waited 7 min for
  compression to make room." When the check that releases the turn finds its
  context fits, the note goes only where it fits too: where the plan's spare
  covers the note's price, by the strategy's own estimate (`estimateTokens`),
  or where a preview at the budget less that price fits. Otherwise the turn
  runs without it, and its wait stays in `inference:hold_ended`'s trace. A
  strategy that gives no preview figures or no estimate leaves the note
  stored as before. A smaller budget stands in for the stored row, so the
  edge of the recent window can differ by a message from the compile's.
  Before its compile, a released start can also store a clock row that has
  come due, the messages that arrived while the turn waited, deferred
  batches, and a module's changed context injection, none of which the check
  sees. Where those tip the compile into a refusal while compression is
  pending, the turn is held again; where compression has nothing left to do,
  the refusal takes the error policy's path, its reason saying that the
  context fit when the hold released it and what the start then added
  didn't.
