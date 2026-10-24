- **Turns opened from a private surface** (WebUI, TUI, CLI, headless, or an
  `api:message`: any `external-message` or `api:message` whose
  `metadata.channelId` names no channel) freeze no inferred channel locus, so
  their plain speech stays on that surface unless the agent uses an explicit
  send. Before, such a turn's speech went to the most recent inbound channel.

  Private wins, one way. A start whose batch holds a private surface's wake is
  private, whatever else the batch holds: directly, through one gate debounce
  window, after a quiesce or a provider hold. So is a start that is the first
  to read a private surface's message stored before it, though the message's
  own wake may still wait in a gate window, or the message woke nothing. A
  channel message whose start is private this way gets no inferred reply in
  its channel. A turn that takes in private input stays private for the rest
  of it: a start that continues it with a private wake or stored private
  input, or a tool boundary that injects a private surface's message, removes
  its locus, its trigger channel and its sticky `>>` or `>>>` destination, and
  a `[routing]` notice says why. While a turn is private, a `>>>` or `>>`
  envelope posts its own body where it names but sets no destination for the
  turn's later speech. What a private turn causes
  is private too: its budget restart, its tool results' re-inference, a ` !`
  continuation, its auto-continuation (`autoContinue`), a bounce's wake, a
  rewind's retry, and the wakes of a script it started (`wake_agent()`, and
  a script left running reporting its end). A script's wakes go by the turn
  that started it as that turn stands when the wake comes, so a turn that
  took in private input after starting the script counts.

  In locus and hybrid modes, a private turn's plain speech is counted in its
  `[delivered]` receipt as kept private, rather than reported as a failed send.
  Explicit mode is unchanged: unprefixed prose bounces, as in any turn. In
  every mode, words a send silenced are held as drafts, as in any turn. Speech
  handlers are told a private turn's speech is private
  (`SpeechContext.nonChannelOrigin`), and the built-in Discord module posts
  none of it and edits its thoughts into no message.

  A private turn's `channel_publish` must name its channel: a call without
  `channelId` is refused, a conversation fork's included. So must a script's
  whose starting turn is private, as that turn stands at the call, whichever
  turn watches the script then. A private turn's `channel_open`
  doesn't move the locus, and says so. Its `.sleep` announcement isn't
  posted. When the model refuses (a refusal stop), a
  private turn's refusal reacts on no message, and its failure record names no
  channel.

  The `[routing]` notice for speech with no channel now says it stays on the
  surface the agent was addressed from, if any.

- **Hosts reading `inboundSource`:** a message whose event's
  `metadata.channelId` is only whitespace is now stamped as a surface's
  (`kind: 'surface'`). Before, it got no source stamp.
