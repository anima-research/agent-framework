- Each agent's context follows its own window (#291): every agent is taken on as it is registered (its window
  written down from the record, then the rows it took in that carry an audience stamp and are elsewhere to the agent,
  such as another agent's own rows, mail stamped for a co-resident and a held row, taken out, traced as
  `presentation:retracted` with reason `elsewhere`, and its own rows stored and not in it presented; a row stored
  before the stamp stays), and a write is stored at once instead
  of queued for a live turn. A row enters each reader's window at
  that reader's presentation points, never inside its turn: an agent's own rows as they are written; another
  writer's rows meant for it at its turn's start, at its tool boundary as a prefix its stream can carry (each body
  whole, cut at the first row the stream can't take, rendered after it is presented) and at its turn's end, and at
  once while no turn of it is alive. A boundary hands its stream exactly the rows its window took, in order, or
  notes the stream's later rounds as unvouched (`presentation:hand-off-mismatch`). An own row whose presentation
  at its write failed is presented ahead of the agent's next own row, so a round's reply never lands after its own
  results; a boundary or hand-off whose read of the store throws is traced as `presentation:failed`, hears
  nothing or vouches for nothing, and the turn goes on; and a window write-down that throws once its record is
  written (a snapshot after the write failing) leaves the window presented rather than the agent in legacy mode.
  Two residents of one slot whose turns overlap each keep a window that is what their requests carried, so each
  request starts with the one before it and their rounds' signed thinking is sent again. A wake for a row stored where it would have been queued reads
  that row (`WritePlacement.presented` false); a write stored during a turn, the gap before a budget restart's
  continuation or a held retry included, takes no clock row, which the turn's boundary or next start takes; a
  debounced batch with a message that names its agents (`targetAgents`, or the one agent a correction is delivered to)
  wakes each agent with the messages it may see, those naming it and those naming no agent, and agents that may see the
  same messages share one line, written for them, and the route of their wake; a batched wake for one message that is
  still newest, with no turn alive, in the window of each agent it's for, or of the delivery agent for a batch naming
  no agent, hands its line to the wake, and each agent
  it wakes writes it at its start as its own row, or leaves it out while the message is still newest there, while
  any other batch writes one line when it fires; and
  another reader's live turn no longer holds back an agent's clock rows, `[continue]` rows or stored injections.
- `undoLastTurn` and `redo` work on the agent's window (decision 4; the breaking entry says what that changes): the
  result's `window` field (`{ retracted, represented }`) says how many rows left or entered it, and a
  `window:undone` trace is emitted, which the API server broadcasts to its clients.
  `TurnCheckpoint` records the window's index length and branch while the context
  is presented. A redo first takes out the rows presented since its undo, which the agent's next point presents
  after the redone turn, so undos redone in turn give back the window they took, in its order. The agent's read
  marks that covered the undone rows (consumed, shown, answered, and each destination's) cover them again once a
  redo puts them back, so a row the redone reply answered isn't taken back as unread. An undo cut short after rows
  left the window (its second retraction refused) is refused with `OperatorActionError` `'failed'` and can be
  redone, or finished by another undo. A redo is refused on another branch than its undo's, where
  `getUndoRedoState().canRedo` is false, and every branch move the framework makes drops the redo entries. A stored
  injection whose copy an undo took out of the window is stored again at the next start.
- `WorkspaceModule.useWindow(lookup)`: how the framework tells the workspace whether an agent's window still holds
  the turn that wrote a mount direct, so the head-move notice follows an undo that moves no branch.
