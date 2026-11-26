- Reactions, edits and deletions that don't address the agent no longer
  move a turn's plain speech away from a message in another channel
  (#189). Before, such a marker could choose the turn's channel when it
  was the newest request and nothing in the batch addressed the agent.
  Now the other requests in the batch come first, an autoContinue wake's
  channel included. Such a marker chooses the channel only if none of
  them names a channel. If none of them names one and the batch holds a
  heartbeat's wake, the turn is a heartbeat's turn and has no channel.
  When a marker is the only request, it still chooses the channel. An
  edit that addresses the agent still ranks as an addressed message. An
  edit still counts as a message when the host knows that it is the
  first version of that message that the agent sees. The wake of a
  deferred batch, and the one-time wake-onboarding wake, take no part:
  they name their channel as before. `InferenceRequest` gains an
  optional `marker` field.
