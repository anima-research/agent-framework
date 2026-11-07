- `EventGate.evaluate(info, after)` takes where the host put the event's own
  message (`WritePlacement`), which the host may fill in until the event's
  batch is delivered. A debounced batch's wake carries the writes it is for
  as `WakeProvenance.writes` (`WakeWrite`: `after`, and `replyTo`, the
  channel a reply is owed in, absent for a message its server marked
  `chat:ambient` or `chat:system`): the message of its own of each event that
  has one and, where one is written, the batch's `[Gate: …]` line. They are
  present only when every event with a message of its own was given its
  write. `InferenceRequest.readsRows` marks a wake whose sole cause is those
  rows, and AgentFramework's scheduler drops it once each row is done as a
  `readsRow` is, judged with its own `replyTo`. EventGate's `isAnswered(after)`
  option says whether the agent has answered a request that carried an
  event's write, `false` only when the host knows it hasn't; the gate asks it
  when a reply judge answers reply, and an event answered then loses its
  write, so the wake starts its turn.
