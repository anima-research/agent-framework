- **Hosts and operators:** a turn held for its context budget (#304, under
  Fixed) is a turn alive until it runs or ends, as a turn a provider hold
  keeps for its retry is. Before, the refused compile ended the turn within
  seconds.
  - `getHostModeStatus()` reads `drained: false` while it waits and lists the
    agent in `activeTurnAgents`, and wakes that join it count in
    `gatedRequests`. A quiesce waits for it: once the hold releases it, the
    turn starts and finishes, as any turn alive at the quiesce does, while
    the wakes that joined it wait for `resume()`. A quiesce with
    `abandon: true` ends it, as do `abortInference()`, `stop()` and a
    conversation agent's disposal, each with one `inference:aborted`. After
    an abandon or `abortInference()`, the wakes that joined it go back to the
    queue and run as a turn of their own.
  - A surgery, a branch switch, and an undo or redo that would move the store
    are refused (`agent-busy`) while a turn is held, and so is
    `puppetToolCall` for the held agent. The refusal names the hold, its
    deadline and its reason, and says that a quiesce with `abandon: true`
    ends the turn. A host that ran surgery on a resident whose turn had ended
    on such a refusal now waits for the hold, up to its 30 minutes, or ends
    the turn.
  - The turn's terminal event comes when the held turn ends, after a hold of
    up to 30 minutes, rather than as an exhaustion within seconds. The
    refused attempt emits `inference:failed`, the turn's next start emits
    `inference:started` again, and new traces `inference:held` and
    `inference:hold_ended` come between. `healthSnapshot()` gives each
    agent's `budgetHold` (or null).
  - The `context-refusal` ops alert goes out when the hold starts (its
    `ops:alert` trace each time, its webhook post at most once per 15 minutes
    for an agent), and says the turn is held until its deadline. A hold's
    drain kicks log as `[budget-hold]`.
- **Agents:** the turn's next start once its hold ends, with a fit or
  without, stores a note in the agent's history saying why it waited, where
  the turn reads it, as an `afterUser` context injection is stored (while the
  window is held, the compile places it instead): "[budget-hold] Your context
  didn't fit its budget (100,201 tokens against 48,568), so this turn waited
  7 min for compression to make room." The note lands before the compile the
  preview judged fit, so at the margin it can tip that compile into a
  refusal, and the hold then holds the turn again until something it watches
  changes.
