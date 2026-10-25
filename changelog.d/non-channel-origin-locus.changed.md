- **Turns opened from a private surface** (WebUI, TUI, CLI, headless, or an
  `api:message`: any `external-message` or `api:message` whose
  `metadata.channelId` names no channel, other than the framework's own
  MCPL tool-list notice) freeze no inferred channel locus, so
  their plain speech stays on that surface unless the agent uses an explicit
  send. Before, such a turn's speech went to the most recent inbound channel.

  Private wins, one way. A start whose batch holds a private surface's wake is
  private, whatever else the batch holds: directly, through one gate debounce
  window, after a quiesce or a provider hold. So is a start that is the first
  to read a private surface's message stored before it, though the message's
  own wake may still wait in a gate window, or the message woke nothing. A
  turn that takes in private input stays private for the rest of it: a start
  that continues it with a private wake or stored private input, or a tool
  boundary that injects a private surface's message, removes its locus, its
  trigger channel and its sticky `>>` or `>>>` destination, and a `[routing]`
  notice says why, whatever destination the turn had. While a turn is private,
  a `>>>` or `>>` envelope posts its own body where it names but sets no
  destination for the turn's later speech. What a private turn causes is
  private too: its budget restart, its tool results' re-inference, a ` !`
  continuation, its auto-continuation (`autoContinue`), a bounce's wake, a
  rewind's retry, a self-wake it arms with `skip_reply`'s `wake_in_seconds`, a
  `sleep`'s wake, the resident's turn after a tune-out cancel it asked for,
  and the wakes of a script it started (`wake_agent()`, and a script left
  running reporting its end). Each goes by the turn that caused it as that
  turn stands when its start reads it, so a turn that took in private input
  after causing it counts, even after the wake was queued. An operator's
  `nudge` or `unstick` retakes a turn, and is private when that turn was, as
  it stands when the retake starts: the newest turn, across a restart too, or
  after an `undo` in the same run, the turn whose inputs the undo leaves last.
  A silent heartbeat tick isn't a turn a retake takes, unless it took in
  private input. A script's wake message is private input, as a private
  surface's message is, when the script's start turn is private as the message
  is stored or injected: a turn that reads it is private, and a tool boundary
  that injects it makes its turn private from there.

  In locus and hybrid mode, a private turn that holds a channel's message
  tells its resident which channels' messages it holds and that its plain
  speech reaches none of them, in a `[routing]` notice before it replies,
  naming each channel once in the turn. That covers a channel wake its start
  takes in, a gate debounce window's channel messages, and a message one of
  its tool boundaries takes in that would have moved a channel turn's locus,
  whether the boundary injects it or leaves it to the turn's next start. In
  explicit and disabled mode no channel's message moves where plain speech
  goes, in any turn, so no channel is named.

  A private turn's plain speech is kept private in every mode. In locus and
  hybrid modes its `[delivered]` receipt counts it and says the plain speech
  went to no channel, rather than reporting a failed send. In explicit mode,
  a private turn's unprefixed speech is no longer bounced and held as a
  draft to resend: a notice says it was kept private and how to publish. In
  every mode, words a send silenced are held as drafts, as in any turn. Speech
  handlers are told a private turn's speech is private
  (`SpeechContext.nonChannelOrigin`), and the built-in Discord module posts
  none of it and edits its thoughts into no message.

  A private turn's `channel_publish` must name its channel: a call without
  `channelId` is refused, a conversation fork's included, and the refusal says
  `channel_list` shows the channel ids, to an agent that may call it. So must
  a script's whose starting turn is private, as that turn stands at the call,
  whichever turn watches the script then. `channel_publish`'s description says
  so, so every agent's tool list changes once. A private turn's `channel_open`
  doesn't move the locus, and says so. Its `sleep` announcement isn't posted.
  When the model refuses (a refusal stop), a private turn's refusal reacts on
  no message, and its failure record names no channel.

  The `[routing]` notice for speech with no channel now says it stays on the
  surface the agent was addressed from, if any.

- **Hosts reading `inboundSource`:** a message whose event's
  `metadata.channelId` is only whitespace is now stamped as a surface's
  (`kind: 'surface'`). Before, it got no source stamp.

- **Turn ids** (`ToolCall.callerTurnId`, `SpeechContext.turnId`) start from
  the clock (milliseconds since the epoch, times 1,000) instead of 1, so an
  id an earlier run of the process gave out is smaller than any a later run
  gives, as long as the clock hasn't gone back between them. They still
  only increase. A script's wake message deferred across a restart, such as
  an update's, names its script's start turn from the earlier run, and the
  next run counts that turn as private, failing closed: a public turn's
  report deferred that way makes the start that reads it private too.
