- Each agent's context follows its own window (#291). Registering an agent takes it on: its window is written down
  from the record, the rows it took in that are elsewhere to it (another agent's own rows, mail stamped for a
  co-resident, a held row) are taken out, traced as `presentation:retracted` with reason `elsewhere`, and its own rows
  not in it are presented; a row stored before the audience stamp stays. A row enters each reader's window at that
  reader's presentation points, never inside its turn: the agent's own rows as they are written; another writer's rows
  meant for it at its turn's start, at its tool boundary (a prefix its stream can carry, each body whole, cut at the
  first row the stream can't take) and at its turn's end, and at once while no turn of it is alive. A boundary hands
  its stream exactly the rows its window took, or notes the stream's later rounds as unvouched
  (`presentation:hand-off-mismatch`); one whose read of the store throws is traced as `presentation:failed`, and the
  turn goes on. An own row whose presentation at its write failed is presented ahead of the agent's next own row, so a
  reply never lands after its own results, and a fresh turn start whose rows from elsewhere can't be taken out of the
  window fails rather than compile with them. An agent left in legacy mode still has each idle reader of its slot
  presented its own rows as it writes them. The held-draft notice written during an agent's turn is presented at once
  to an idle agent that observes it, or to the persistent subconscious, and to its own agent at the turn's next point.
  Two residents of one slot whose turns overlap each keep a window that is what their requests carried, so each
  request starts with the one before it and their rounds' signed thinking is sent again.
  - A wake for a row stored where it would have been queued reads that row (`WritePlacement.presented` false), and a
    write stored during a turn takes no clock row, which the turn's boundary or next start takes. A debounced batch
    with a message that names its agents (`targetAgents`, or the one agent a correction is delivered to) wakes each
    agent with the messages it may see, those naming it and those naming no agent, and agents that may see the same
    messages share one line and its wake's route; a batched wake for one message still newest in the window of each
    agent it's for hands its line to the wake, which each agent writes at its start as its own row, or leaves out
    while the message is still newest there. Another reader's live turn no longer holds back an agent's clock rows,
    `[continue]` rows or stored injections.
- `undoLastTurn` and `redo` work on the agent's window (see Breaking: every agent's context follows its own
  presentation index): the result's `window` is `{ retracted, represented }`, and `TurnCheckpoint` records the
  window's index length and branch. A redo first takes out the rows presented since its undo, which the agent's next
  point presents after the redone turn, and the read marks that covered the undone rows cover them again. An undo cut
  short after rows left the window is refused with `OperatorActionError` `'failed'` and can be redone, or finished by
  another undo. A redo is refused on another branch than its undo's (`getUndoRedoState().canRedo` false), and every
  branch move the framework makes drops the redo entries. A stored injection whose copy an undo took out is stored
  again at the next start.
- `WorkspaceModule.useWindow(lookup, turnAlive?)`: how the framework tells the workspace whether an agent's window
  still holds the turn that wrote a mount direct, so the head-move notice follows an undo that moves no branch. A turn
  an earlier release stored, with no audience stamp, is the agent's by the rule the undo takes it out by; a write made
  while no turn of the agent's is alive is judged by the branch's position alone, as `turnAlive` tells the workspace,
  and the saved positions carry that mark (`outsideTurn`).
