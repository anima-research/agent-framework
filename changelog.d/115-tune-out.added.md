- **Tune-out (#77): subconscious summaries instead of unsubscribing.** A third
  channel state between subscribed and gone: `tune_out` diverts a channel's
  traffic to a persistent same-model side-agent (participant `Subconscious`)
  that summarizes on a cadence in its own voice, judges wakes (addressed
  messages and gate-privileged authors, both preconditioned by the resident's
  wake gate), and can cancel. Suppressed mentions get a deterministic
  `channels/acknowledge` reaction; wake budgets are durable in the
  `mcpl/channel-lifecycle` log with max-wakes auto-cancel; optional
  `durationSeconds` gives a tune-out a restart-surviving deadline. Cancel
  delivers a capped `<tuned-out-backlog>` dump plus a subconscious report;
  diverted messages never enter the residents' compiled view (cm `viewFilter`)
  and stay excluded after cancel. Standing dispositions ride a fixed
  system-position injection on the subconscious's compiles. Requires
  `@animalabs/context-manager` with strategy-view composition
  (context-manager#54); designer review record in #115.
- **`targetAgents` honored on the channel-incoming fan-out** (was declared but
  dead); untargeted events keep the historical broadcast.
- **Per-agent message delivery**: `addMessage(…, {forAgent})` with deferral and
  turn-alive guards evaluated against the target agent; gate self-wake notices
  deliver to the waking agent. Default path unchanged.
