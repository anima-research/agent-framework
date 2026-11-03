- `FrameworkConfig.unpromptedChannel`: the channel for a turn no channel
  message prompted, while the turn has no channel of its own, such as a
  self-scheduled wake's or a sleep's end. Plain speech in locus or hybrid prose
  routing goes there, and so does `channel_publish` naming no channel, where
  they would otherwise take the global fallback: an all-except hold's channel
  while one is open, else none under the default `speech.locus: 'delivery'`,
  and the latest inbound message's channel under `'latest-inbound'`. It
  doesn't apply to a turn a channel message prompted, addressed or not, nor
  to a conversation fork's, a heartbeat's or an ephemeral run's turn. One
  value, for every agent on the framework. Without it, nothing changes.
- `WakeProvenance.channelBorne` and `InferenceRequest.channelBorne`: set when
  a gate batch held an event from a channel, addressed or not, and on a merged
  batch when any of its causes is. A channel message prompted such a turn,
  so it never takes `unpromptedChannel`.
