- `FrameworkConfig.homeChannel`: where speech goes on a turn with no
  triggering channel (heartbeats, timers). Such turns used to fall back to the
  most-recent inbound channel across all channels, so a check-in landed
  wherever a message last arrived. A conversation fork's home and a turn's
  triggering channel still take precedence; without the option, behaviour is
  unchanged.
