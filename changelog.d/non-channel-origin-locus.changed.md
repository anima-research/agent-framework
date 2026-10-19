- **Fresh turns opened from WebUI/TUI/CLI/headless/API:** private-surface input
  freezes no inferred channel locus, so plain prose stays on its originating
  surface unless the agent uses an explicit send. Starts that continue that
  logical turn retain the same private routing state. Private input that arrives
  inside an already-open channel turn is not covered here; sticky content-origin
  privacy is tracked separately and should align with the speech-route work.

  A private turn's plain prose is counted in its `[delivered]` receipt as kept
  private, and is not held as a draft to resend, except words after a `>>>`
  envelope that failed, which were aimed at a channel. A private surface's wake
  and a channel's never start one turn together: not from one batch, one gate
  debounce window or one quiesce, and a start that continues a turn keeps that
  turn's kind. An ambient channel event that shares a gate window with a
  private message shares its private turn, and nothing answers it in its
  channel.

  Real-turn hooks get the turn's frozen locus as `defaultOutgoing`. Explicit,
  disabled and private turns have none. Private turns also omit `incoming`.
  They require an explicit `channelId` for `channel_publish`, a conversation
  fork's included, keep `channel_open` from moving the prose locus, and skip
  refusal reactions to the process-global last inbound channel.

  An `external-message` or `api:message` whose `metadata.channelId` names its
  channel, and whose `metadata.tags` carry `chat:addressed`, is addressed, as a
  channel message is: its turn answers in that channel ahead of ambient traffic.

  `channel_publish`'s description and its `channelId` parameter's description
  changed, so the first request after the upgrade that carries the channel
  tools misses the prompt cache from it.
