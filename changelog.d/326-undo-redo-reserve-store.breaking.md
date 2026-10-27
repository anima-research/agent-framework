- **Hosts and API clients that call `undoLastTurn()`, `redo()` or
  `switchBranch()`, or change an agent's runtime settings:** each of these
  can now be refused with `OperatorActionError` (`agent-busy`), where on
  0.27.0 it went ahead, by our reading of 0.27.0's code:
  - `undoLastTurn()` and `redo()`, while any agent sharing the store is
    busy or a conversation agent is being created, since the branch moves
    under every agent sharing the store. A refused undo or redo keeps its
    checkpoint or redo entry;
  - `switchBranch()` while another move holds the store for its
    re-initialization: a second switch made together with one, which
    0.27.0 refused only while the first still waited for running
    maintenance or a workspace module's mount (a run shows two made
    together with neither both going ahead there), and a switch made
    during an undo's or redo's re-initialization;
  - a runtime-settings change, reset or cancelled transition while an
    undo's or redo's re-initialization, or a surgery, holds the store.
    Nothing of it is applied.

  Retry once the agents are idle and the store is released: an undo's or
  redo's `settled` says when its hold ends.
