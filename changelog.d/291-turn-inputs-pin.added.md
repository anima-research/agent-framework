- `AgentConfig.turnInputsPin`: `false` turns off 0.31.0's turn-opening pin (`agent-framework:turn-inputs`) for an
  agent, which had no setting. Its turns then pin nothing, so the rows a turn opens with are compressed as any others
  while it runs, and a pin of the name left from before is removed at the next start that opens a turn, as a silent
  start removes one. On when left out, so nothing changes unless it is set; anything but true or false is refused.
