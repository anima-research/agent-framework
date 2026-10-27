- **Hosts and API clients that call `switchBranch()`, or change an agent's
  runtime settings:** each of these can now be refused with
  `OperatorActionError` (`agent-busy`), where on 0.27.0 it went ahead, by our
  reading of 0.27.0's code:
  - `switchBranch()` while another move holds the store for its
    re-initialization: a second switch made together with one, which
    0.27.0 refused only while the first still waited for running
    maintenance or a workspace module's mount (a run shows two made
    together with neither both going ahead there);
  - a runtime-settings change, reset or cancelled transition while a move's
    re-initialization, or a surgery, holds the store. Nothing of it is
    applied.

  Retry once the agents are idle and the store is released. `undoLastTurn()`
  and `redo()` are on the agent's window (#291, the 291-presentation-mandatory
  entry): they move no branch and reserve nothing, so they gain none of these
  refusals.
