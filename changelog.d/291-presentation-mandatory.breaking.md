- **Hosts: every agent's context follows its own presentation index** (#291). `FrameworkConfig.presentationIndex`
  is removed: what it turned on is how every framework runs (see the presentation index's entries), and a host's
  configuration that still passes it is read as any unknown key is. `create()` refuses a context-manager without
  `ContextManager.presentRows` (one before 0.25.0), and a store handle without chronicle's
  `appendManyToStateJsonWithIdentity` (one from chronicle 0.5.0 or earlier), each naming the range this package
  declares (the 291-chronicle-0.6 entry). An agent whose window
  can't be written down at its registration (another version's index format, a failed write) stays in legacy mode,
  its window the whole record, as before, until a branch move writes its window down on the new branch.
  - **Undo and redo are on the agent's window** (decision 4): `undoLastTurn` takes the turn's rows out of the
    agent's window, its own as undone and others' back to arrived, and `redo` puts them back. Neither writes the
    record or moves a branch, so neither reverts the workspace or `_config` mounts, MCPL checkpoints or the
    inference log any more: `rollbackToMessage` is the record-level revert. The result's `fromBranch` and `toBranch`
    are both the store's branch and its `window` says how many rows left or entered; the `undo:completed` and
    `redo:completed` traces are removed in favour of `window:undone`, and the API server broadcasts `window:undone`
    in place of `branch:switched` for them. Both are refused while a turn of the agent's is alive, and for an agent
    whose window isn't presented; a redo also on another branch than its undo's, which the base redo switched back
    to. Moving no branch, an undo or redo reserves nothing and re-initializes no context manager, as a branch move
    does (0.28.0's entry on the context managers after a branch move), so every other agent goes on compiling, and
    the result carries no `settled`. So neither takes 0.28.0's `agent-busy` refusals while another agent sharing
    the store is busy or a conversation agent is being created, a coalesced update or retraction made meanwhile
    isn't held back, and neither judges a conversation agent for disposal, as a move does.
  - **Context-manager's MANIFEST:** the first window write-down that holds rows, or any presentation of more than
    one row, moves the store's MANIFEST to version 2, which chronicle 0.5.0 and earlier refuse, and so does a release
    whose chronicle range resolves one, such as agent-framework 0.30.0 or context-manager 0.24.0 (context-manager's
    291-window-batches entry). Going back to an earlier release after that needs a copy of the store taken before
    the upgrade.

  **Migration:** drop `presentationIndex` from the configuration. A host that listened for `undo:completed`,
  `redo:completed`, or `branch:switched` with reason `undo`/`redo`, to refresh a view listens for `window:undone`.
  A host that relied on undo reverting a mount or the inference log uses `rollbackToMessage`.
- A fork derived inside a tool call is handed the results already received — all of them while a tool boundary builds them for storing — with the note for the call that derived it and for any call still running, so it never meets a dangling `tool_use` (the 0.30.0 `pendingRound` entry, read onto the presentation index).
