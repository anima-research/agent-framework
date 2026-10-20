- **Turns opened from a private surface** (WebUI, TUI, CLI, headless, or an
  `api:message`: any `external-message` or `api:message` whose
  `metadata.channelId` names no channel) freeze no inferred channel locus, so
  their plain speech stays on that surface unless the agent uses an explicit
  send. Before, such a turn's speech went to the most recent inbound channel.

  Private wins, one way. A start whose batch holds a private surface's wake is
  private, whatever else the batch holds: directly, through one gate debounce
  window, after a quiesce or a provider hold. A channel message that shares
  such a start gets no inferred reply in its channel. A turn that takes in
  private input stays private for the rest of it: a start that continues it
  with a private wake, or a tool boundary that injects a private surface's
  message, removes its locus and its sticky `>>` or `>>>` destination, and a
  `[routing]` notice says so. What a private turn causes is private too: its
  budget restart, its tool results' re-inference, a ` !` continuation, a
  bounce's wake and a rewind's retry.

  In locus and hybrid modes, a private turn's plain speech is counted in its
  `[delivered]` receipt as kept private, rather than reported as a failed send.
  Explicit mode is unchanged: unprefixed prose bounces, as in any turn. In
  every mode, words a send silenced are held as drafts, as in any turn. Speech
  handlers are told a private turn's speech is private
  (`SpeechContext.nonChannelOrigin`), and the built-in Discord module posts
  none of it and edits its thoughts into no message.

  A private turn's `channel_publish` must name its channel: a call without
  `channelId` is refused, a conversation fork's included. Its `channel_open`
  doesn't move the locus, and says so. Its refusal reacts on no message, and
  its refusal record names no channel.

  The `[routing]` notice for speech with no channel now says it stays on the
  surface the agent was addressed from, if any.

- **Scripts:** a script's `channel_publish` must name its channel, whatever
  turn is open, a conversation fork's included. Before, one without
  `channelId` went to the channel of the most recent inbound message.

- **Hosts reading `inboundSource`:** a message whose event's
  `metadata.channelId` is only whitespace is now stamped as a surface's
  (`kind: 'surface'`), where before it was left as a channel's.
