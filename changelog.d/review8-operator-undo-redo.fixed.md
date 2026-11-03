- An undo or a redo on an agent's window (`undoLastTurn`, `redo`) whose
  later step fails after its rows left or returned is refused with
  `OperatorActionError` `'failed'`. The message says how many rows left and
  how many returned, and the failure is traced (`window:undone`) and
  written to the operator log with its error. The redo entry stays. Before,
  such a failure threw the store's error. An undo whose checkpoint save
  failed then left its checkpoint saved, so a retried undo kept an empty
  redo, and the first redo restored nothing. Now the next undo saves the
  checkpoints without the undone turn and keeps no second redo, and the
  next redo of a redo whose save failed saves it. A redo's `window:undone`
  trace is now emitted after its entry leaves the redo stack, so a
  listener that undoes the turn again keeps its own entry.
