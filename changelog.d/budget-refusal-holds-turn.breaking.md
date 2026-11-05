- **Hosts and operators that run a surgery, a branch switch, an undo or a
  redo, or `puppetToolCall`:** each of these can now be refused while a turn
  the context budget refused is held (#304, under Fixed), where on 0.32.0
  that refusal ended the turn within seconds and the action then went ahead.
  A surgery, a branch switch, an undo and a redo are refused with
  `OperatorActionError` (`agent-busy`); `puppetToolCall` throws an `Error`
  whose message begins `puppet refused:`, as it does for a turn a provider
  hold keeps.
  - A surgery, a branch switch, and an undo or redo that would move the
    store are refused for every agent sharing the store, not only the held
    one, as the store-wide surgery gate refuses them while a provider hold
    keeps a turn's retry; `puppetToolCall` is refused for the held agent. The
    refusal names the hold and its reason, and says that a quiesce with
    `abandon: true` ends the turn.
  - **Migration:** wait for the hold to end, or end the held turn with a
    quiesce with `abandon: true` or with `abortInference()`, and then run the
    action.
  - **Unchanged:** each of these actions while no turn sharing the store is
    held.
