- **`ContextMaintenanceAgentRun.leftPassAt`:** when an agent's tick left its
  maintenance pass because a provider call of that agent parked at its
  provider gate while the tick ran: the tick's own, behind the agent's turn
  or a provider cooldown, or another of the agent's calls, such as an
  over-budget drain's. Such an entry is unfinished, with no `finishedAt`,
  until the tick settles; `leftPassAt` tells it apart from a tick still in
  its pass.
