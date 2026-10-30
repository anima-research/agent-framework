- `EventGate`: what the gate held for an agent's turn is delivered just
  after the turn ends, and a turn starting or a quiesce in between no longer
  lets it through: it stays held, in arrival order and under the backlog's
  cap, until that turn ends or the quiesce lifts. What it held when
  `dispose()` came isn't delivered. Found by theaspirational.
