- **Fresh turns opened from WebUI/TUI/CLI/headless/API:** private-surface input
  freezes no inferred channel locus, so plain prose stays on its originating
  surface unless the agent uses an explicit send. Starts that continue that
  logical turn retain the same private routing state. Private input that arrives
  inside an already-open channel turn is not covered here; sticky content-origin
  privacy is tracked separately and should align with the speech-route work.

  In locus and hybrid modes, a private turn's plain prose is counted in its
  `[delivered]` receipt as kept private, and is not held as a draft to resend,
  except words a `>>>` envelope aimed at a channel. Explicit mode is unchanged:
  unprefixed prose bounces, as in any turn. Speech handlers are told a private
  turn's speech is private (`SpeechContext.nonChannelOrigin`), and trace
  listeners are told its start is (`inference:started`'s `nonChannelOrigin`).
  The built-in Discord module posts none of its speech, edits its thoughts into
  no message, and shows no typing for it: a module with its own speech handler
  or typing indicator can use the fields to do the same.

  A private surface's wake and a channel's never start one turn together: not
  from one batch, one gate debounce window or one quiesce. A start that
  continues a turn keeps that turn's kind, and takes no private surface's wake
  into a turn that isn't private. Such wakes wait for the open turn to end; an
  idle agent's open turn that has had nothing of its own kind to start for 30
  seconds ends, and a `[inference-stale]` line says so. An ambient channel event
  that shares a gate window with a private message shares its private turn,
  and nothing answers it in its channel.

  Real-turn hooks get the turn's frozen locus as `defaultOutgoing`. Explicit,
  disabled and private turns have none. Private turns also omit `incoming`.
  They require an explicit `channelId` for `channel_publish`, a conversation
  fork's included, and so does a call `executeToolCall` makes as the agent
  during one. They keep `channel_open` from moving the prose locus, skip
  refusal reactions to the process-global last inbound channel, and record a
  refusal with no channel.

  An `external-message` or `api:message` whose `metadata.channelId` names its
  channel, and whose `metadata.tags` carry `chat:addressed`, is addressed, as a
  channel message is: its turn answers in that channel ahead of ambient traffic.
  Such a message's channel stays the fork's when a conversation fork owns it.

  When an agent's speech has no channel, its `[routing]` notice now says it
  stays on the surface the agent was addressed from, if any.

  `channel_publish`'s description and its `channelId` parameter's description
  changed, so the first request after the upgrade that carries the channel
  tools misses the prompt cache from it.
