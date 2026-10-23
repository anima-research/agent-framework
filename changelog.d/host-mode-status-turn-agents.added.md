- `HostModeStatus.activeTurnAgents` lists, sorted, the agents with a turn
  alive, the ones `activeTurns` counts: each from its turn's dequeue to its
  settled teardown, so a turn in its hooks or compile, one finishing its
  deliveries, or one whose continuation is on its way to its start, is
  listed. So a host can record which agents are mid-turn before it abandons
  their turns or stops.
