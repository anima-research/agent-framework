- `FrameworkConfig.unpromptedChannel`: the channel for a turn no channel
  message prompted, while the turn has no channel of its own, such as a
  self-scheduled wake's or a sleep's end. Plain speech in locus or hybrid prose
  routing goes there, and so does `channel_publish` naming no channel in any
  mode, which servers are told as the turn's default outgoing channel. An
  all-except hold's channel still comes first while one is open. Without the
  setting, such a turn takes the global fallback: the hold's channel, else
  none under the default `speech.locus: 'delivery'`, or the latest inbound
  message's channel under `'latest-inbound'`. It doesn't apply to a turn a
  channel message prompted, addressed or not, nor to a conversation fork's, a
  heartbeat's or an ephemeral run's turn. One value, for every agent on the
  framework.
- `WakeProvenance.channelBorne` and `InferenceRequest.channelBorne`: set when
  a gate batch held an event from a channel, addressed or not, on a
  tune-out's release wake, whose turn reads the held messages, and on a
  merged batch when any of its causes is. Channel messages prompted such a
  turn, so it never takes `unpromptedChannel`.
