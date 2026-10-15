- A start that continues a logical turn now keeps what the turn has decided
  about where its speech is published. Those starts are a framework retry
  after a stream error, the re-inference that consumes unstreamed tool
  results, and the compile a provider-capacity hold defers a turn to (#314).
  Before, each began with fresh routing:
  - in hybrid mode, the hold after `>>>skip_reply` was dropped, so the new
    stream's unprefixed prose was published to the turn's locus;
  - the sticky destination was dropped in both modes, so unprefixed prose
    went to the locus in hybrid mode, and in explicit mode bounced with a
    notice and a wake, while the new stream streamed nothing;
  - the turn's locus was resolved again: a retry lost a mid-turn addressed
    re-pin, a re-inference took the locus of whichever wake started it, and
    a held turn's later compile let a newer ambient message move it.

  A hybrid stream's live outgoing deltas still start at the turn's locus,
  as before.
- A message that no tool boundary weighed now moves the turn's locus at the
  turn's next start, by the rule a mid-turn message follows: a
  conversational message that addressed the agent, or that follows up in a
  channel the turn sent into, with the same
  `[routing] The conversation moved to …` notice. That covers a message that
  arrives during a capacity hold or before a re-inference, and one drained
  at a budget restart's over-budget boundary, which before never moved the
  locus. Ambient traffic in a channel the turn hasn't sent into, reactions
  and system markers don't move it. Neither does a message the agent won't
  see: one that tune-out diverts, or one removed before that start, such as
  an unread coalesced message its server retracted. The newest qualifying
  message that remains decides. Residents read one message slot, and a
  tool boundary weighs only the messages drained for its own agent, so each
  resident's open turn also takes, by the same rule, a message stored for
  another resident whenever it lands, including one that resident's
  boundary drained. A message tagged as addressed addresses the account the
  residents share, so it can move any resident's turn.
- A silent turn's tool boundary no longer re-pins its locus or adds a
  `[routing]` notice to its stream.
- For a trunk agent, the channel context passed to `beforeInference` hooks
  (`channels.defaultOutgoing`) names the turn's locus once the turn has one.
  After a re-pin, a later start of the turn reports the locus it moved to,
  where its unprefixed speech is published unless a hybrid `>>>` destination
  takes it, not the channel that triggered the turn. A conversation fork
  still reports its home channel.
- A start that fails before its stream exists now lands the messages
  deferred during it, as a stream's end does. Before, they waited for the
  agent's next start and landed after any message stored in between. A
  start that throws outside its stream's failure handling ends its logical
  turn, so the agent's next start opens its own, and an ephemeral run
  (`runEphemeralToCompletion`) whose start throws that way fails at once
  with the start's error. Before, the run waited for its watchdog: 30 s by
  default before its inference started, or 15 minutes once it had.
- A send's engaged channel is recorded on the turn that called the tool,
  even when the open that follows the send comes after that turn has ended.
  A `channel_open` moves the locus of the turn that called it while that
  turn is open. Its result tells the agent of the move, so one that comes
  after the turn ended moves nothing: the result is dropped unread.
