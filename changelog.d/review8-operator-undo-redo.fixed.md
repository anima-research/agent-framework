- An undo or a redo on an agent's window (`undoLastTurn`, `redo`) whose later step fails after its rows left or
  returned is refused with `OperatorActionError` `'failed'`, saying how many rows left and how many returned; the
  failure is traced (`window:undone`) and written to the operator log with its error, and the redo entry stays.
  In 0.32.0 a redo whose checkpoint save failed after its switch threw the store's error, its entry already taken
  off the stack. A redo's `window:undone` trace is emitted after its entry leaves the redo stack, so a listener
  that undoes the turn again keeps its own entry.
