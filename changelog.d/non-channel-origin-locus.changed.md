- **Fresh turns opened from WebUI/TUI/CLI/headless/API:** private-surface input
  freezes no inferred channel locus, so plain prose stays on its originating
  surface unless the agent uses an explicit send. Starts that continue that
  logical turn retain the same private routing state. Private input that arrives
  inside an already-open channel turn is not covered here; sticky content-origin
  privacy is tracked separately and should align with the speech-route work.

  Real-turn `beforeInference` hooks now receive the frozen turn channel context;
  explicit/disabled private turns expose neither incoming nor default outgoing
  channels. Private turns also require an explicit `channelId` for
  `channel_publish`, keep `channel_open` from moving the prose locus, and skip
  refusal reactions to the process-global last inbound channel.
