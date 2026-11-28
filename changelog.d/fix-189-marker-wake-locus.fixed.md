- Reactions, edits and deletions that don't address the agent no longer
  move a turn's plain speech away from a message in another channel
  (#189). Before, such a marker could choose the turn's channel when it
  was the newest request and nothing in the batch addressed the agent.
  Now the other requests in the batch come first, an autoContinue wake's
  channel included. Such a marker chooses the channel only if no other
  request names one and the batch holds no heartbeat's wake. With a
  heartbeat's wake, the turn is a heartbeat's turn and has no channel,
  so its plain words stay a draft and aren't published in the marker's
  channel. When a marker is the only request, it still chooses the
  channel. A deletion or a removed reaction never addresses the agent
  here, even when its server gives it an addressing tag, as zulip_mcp
  gives a deletion its message's. An edit that addresses the agent still
  ranks as an addressed message. An edit still counts as a message when
  the host knows that it is the first version of that message that the
  agent sees. The wake of a deferred batch, and the one-time
  wake-onboarding wake, take no part: they name their channel as before.
  `InferenceRequest` gains an optional `marker` field.
