- **With `FrameworkConfig.presentationIndex` on** (#291, @experimental), what changes for a host:
  - An undo takes the turn's rows out of the agent's window, its own as undone and others' back to arrived, which
    its next presentation point presents again; a redo first takes out what was presented since, then puts the
    turn's rows back in their order. Neither writes the record or moves a branch, so neither reverts the workspace
    or `_config` mounts, MCPL checkpoints or the inference log: `rollbackToMessage` is the record-level revert.
    An undo or redo is refused while a turn of the agent's is alive, and allowed while another agent's is.
  - A quiesce freezes every window but for each agent's own rows: a write is stored and presented at resume, and a
    turn draining through the quiesce hears nothing at its tool boundaries.
  - While a surgery holds the store (a rollback, a suppression, a branch switch), writes are held in memory, not in
    the persisted queue, and replayed in arrival order at its release, where each idle reader is presented them.
  - A row stored for an agent is in its context's record at once: a host that reads `getAllMessages()` sees rows
    its agent's window doesn't hold yet (`getPresentedMessages()` is the window).
