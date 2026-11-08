- **Hosts and operators that run a surgery, a branch switch, an undo or a
  redo, or `puppetToolCall`:** each of these can now be refused while a turn
  the context budget refused is held (#304, under Fixed), where on 0.33.0 and
  earlier that refusal ended the turn within seconds and the action then went
  ahead.
  A surgery, a branch switch, an undo and a redo are refused with
  `OperatorActionError` (`agent-busy`); `puppetToolCall` throws an `Error`
  whose message begins `puppet refused:`, as it does for a turn a provider
  hold keeps.
  - A surgery and a branch switch are refused for every agent sharing the
    store, not only the held one, as the store-wide surgery gate refuses them
    while a provider hold keeps a turn's retry; their refusal names the hold
    and its reason, and says that a quiesce with `abandon: true` ends the
    turn. `puppetToolCall` is refused for the held agent, naming the hold the
    same way. An undo and a redo, which work on the agent's window, are
    refused for the held agent only, as for any turn of its that is alive
    (`Cannot undo: a turn of <agent>'s is alive`, or `Cannot redo: …`).
  - **Migration:** wait for the hold to end, or end the held turn with a
    quiesce with `abandon: true` or with `abortInference()`, and then run the
    action.
  - **Unchanged:** each of these actions while no turn sharing the store is
    held, and an undo or a redo of another agent while one is.
- **Hosts that route ops-alert kinds:** a turn the context budget refused
  raises `context-hold` (under Added) while it's held, where on 0.33.0 and
  earlier the refused turn's exhaustion raised `context-refusal` within
  seconds. A host that posts only the kinds it lists, and treats an unlisted
  kind as silent, posts nothing while a resident waits on its budget.
  - **Migration:** give `context-hold` a place where you post alerts. Its
    end is `context-hold-clear`, so a host that pairs `-clear` kinds closes
    it with no more work. A held turn raises one of each, however often its
    released start is refused and held again, unless a provider hold takes
    it between.
  - **Unchanged:** `context-refusal` is still raised when a hold ends with
    nothing left for compression to do and the turn's compile is refused
    again, as for any exhausted turn.
- **Hosts that quiesce and wait for the drain:** a quiesce without `abandon`
  doesn't drain while a turn is held, since the held turn is alive until it
  runs or ends and a hold has no time limit (under Changed), where on 0.33.0
  and earlier the refused turn ended within seconds and the quiesce drained.
  - **Migration:** wait for the hold to end, or end the turn with
    `abortInference()` or a quiesce with `abandon: true`.
  - **Unchanged:** a quiesce while no turn is held, and a turn a provider
    hold keeps for its retry, which a quiesce has waited for since #774.
