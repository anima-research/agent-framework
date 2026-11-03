- `FrameworkConfig.unpromptedChannel`: where speech goes on a turn with no
  triggering channel (heartbeats, timers). Such turns used to fall back to the
  most-recent inbound channel across all channels, so a check-in landed
  wherever a message last arrived. A conversation fork's home and a turn's
  triggering channel still take precedence; without the option, behaviour is
  unchanged.
- `WakeProvenance.channelBorne` and `InferenceRequest.channelBorne`: set when
  a gate batch held an event from a channel, addressed or not, and on a merged
  batch when any of its causes is. A channel message prompted such a turn,
  so it never takes `unpromptedChannel`.
