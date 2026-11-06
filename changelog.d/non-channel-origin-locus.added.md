- `ChannelRegistry`'s options gain `privateTurn`, `(agentName) => boolean`:
  whether the agent's current turn is private. Where it says so, the
  agent's channel context (`buildChannelContext`, which gives an MCPL server
  its `context/beforeInference` channels) names no default outgoing channel,
  a conversation fork's home included, and `incomingFor` gives no message.
  Left out, both are as before. The framework sets it for the registry it
  makes, from whether the turn holds private input.
