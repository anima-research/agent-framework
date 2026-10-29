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
  continuation or a held retry included, takes no clock row, which the turn's boundary or next start takes; each resident a batched wake is for writes its own line, at its own start; and
  another reader's live turn no longer holds back an agent's clock rows, `[continue]` rows or stored injections.
- `undoLastTurn` and `redo` work on the agent's window (decision 4; the breaking entry says what that changes): the
  result's `window` field (`{ retracted, represented }`) says how many rows left or entered it, and a
  `window:undone` trace is emitted. The API server broadcasts a `window:undone` event (with the agent's name, the
  counts and the reason) for them. `TurnCheckpoint` records the window's index length and branch while the context
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
