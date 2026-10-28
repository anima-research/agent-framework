- `ChannelRegistry` no longer evaluates the wake gate or sets the publish
  locus at ingestion: `shouldTriggerInference` is the per-server veto only,
  and the framework reports delivered messages through `noteDelivered` after
  admission. `channel_publish` without a `channelId` publishes where the calling
  agent's plain speech would land (under explicit or disabled prose
  routing, the turn's trigger channel), and is refused where there's none.
- `TuneOutCoordinator.onIncoming` is split into `holdFor` (the pure lookup
  admission uses) and `recordHeld` (the bookkeeping that follows a hold);
  `cancel` takes the lifecycle state to return to; `enter` no longer
  requires a reader.
