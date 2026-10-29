- `ChannelRegistry` no longer evaluates the wake gate or sets the publish
  locus at ingestion: `shouldTriggerInference` is the per-server veto only,
  and the framework reports delivered messages through `noteDelivered` after
  admission. `channel_publish` without a `channelId` goes to the calling turn's
  locus, else a conversation fork's home channel, else the turn's trigger
  channel, else the registry's default, which an ephemeral agent (one
  `createEphemeralAgent` or `resumeAgent` made, derivations included) or a
  turn with no channel by design (`noChannel`, or a heartbeat) doesn't
  take; the call is refused when none of these names a channel.
- `TuneOutCoordinator.onIncoming` is split into `holdFor` (the pure lookup
  admission uses) and `recordHeld` (the bookkeeping that follows a hold);
  `cancel` takes the lifecycle state to return to; `enter` no longer
  requires a reader.
