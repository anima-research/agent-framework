- `HostModeStatus.activeTurnAgents` lists, sorted, the agents holding a turn,
  the ones `activeTurns` counts: each from its turn's dequeue to its settled
  teardown, so a turn in its hooks or compile, or one finishing its
  deliveries, is listed. So a host can record which agents are mid-turn
  before it abandons their turns or stops.
