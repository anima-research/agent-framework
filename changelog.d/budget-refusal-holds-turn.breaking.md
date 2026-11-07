- **Hosts and operators that run a surgery, a branch switch, an undo or a
  redo, or `puppetToolCall`:** each of these can now be refused while a turn
  the context budget refused is held (#304, under Fixed), where on 0.32.0
  that refusal ended the turn within seconds and the action then went ahead.
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
