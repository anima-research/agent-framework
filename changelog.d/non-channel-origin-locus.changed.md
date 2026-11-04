- **Turns opened from a private surface** (WebUI, TUI, CLI, headless, or an
  `api:message`: any `external-message` or `api:message` whose
  `metadata.channelId` names no channel, other than the framework's own
  MCPL tool-list notice) take no fallback channel, so their plain speech
  stays on that surface unless the agent uses an explicit send. Before, such
  a turn took 0.30.0's fallback: the excepted channel while an all-except
  tune-out is open, and under `speech.locus: 'latest-inbound'` the most
  recent inbound channel.

  Private wins, one way. A start whose batch holds a private surface's wake is
  private, whatever else the batch holds: directly, through one gate debounce
  window, after a quiesce or a provider hold. A provider hold that keeps one
  request for two equal ones keeps the marks of both, and when one of them is
  a merged start and the other isn't, each request of the start's batch takes
  the other's marks, a private wake's included. So is a start that is the
  first
  to read a private surface's message stored before it, though the message's
  own wake may still wait in a gate window, or the message woke nothing, and
  for an ordinary resident whose view keeps the message, whichever resident
  of its shared slot it was stored for. So is a resident's first start in a
  framework made on its store, as after a restart, when, in what its view
  keeps, no row of the resident's own, other than a silent heartbeat tick's,
  follows a private surface's message, a result or mail from a private turn's
  work, or a report from a script a turn started, whichever turn it was: what
  the earlier run had noted went with it. So is
  the turn of its own that a wake starts after waiting beside a private
  turn's own continuation: a budget restart or a held retry that started
  alone, or one that passed a quiesce in the same pass that parked the wake.
  A wake that waited on a private turn with no continuation beside it starts
  a channel's later turn, private only as any other start is. A turn that
  takes in
  private input stays private for the rest of it: a start that continues it
  with a private wake or stored private input, or a tool boundary that injects
  a private surface's message, removes its locus, its trigger channel and its
  sticky `>>` or `>>>` destination, and a `[routing]` notice says why,
  whatever destination the turn had, unless the turn is a silent heartbeat
  tick, which has no speech to place. A heartbeat's turn that takes in private
  input is private too: its plain speech is kept private rather than held as
  drafts, as 0.29.0 holds a heartbeat turn's, and a turn private from its
  start isn't told that its words are held. While a turn is private, a `>>>`
  or `>>` envelope posts its own body where it names but sets no destination
  for the turn's later speech. What a private turn causes is private too: its
  budget restart, its tool results' re-inference, a ` !` continuation, its
  auto-continuation (`autoContinue`), a bounce's wake, a rewind's retry, its
  re-send after its retries ran out (`exhaustedTurnRearmMs`), a self-wake it
  arms with `skip_reply`'s `wake_in_seconds`, a `sleep`'s wake, the resident's
  turn after a tune-out cancel it asked for, an all-except hold's included,
  and the wakes of a script it started (`wake_agent()`, and a script left
  running reporting its end). Each
  goes by the turn that caused it as that turn stands when its start reads it,
  so a turn that took in private input after causing it counts, even after the
  wake was queued. An operator's `nudge` or `unstick`, or an
  `inference.request` through the API server or its MCP tool
  (`agent_request_inference`), answers the agent's context as it stands, so it
  is private exactly when, as it starts, the agent's stored history holds a
  private surface's message, or a result or mail from a private turn's work
  (`dendrite.privateTurn`), or when, as any start can, it takes a note that
  private input waits: the restart rule above, or private input stored for
  the agent since its last start that wasn't a silent heartbeat tick, which
  an undo, redo or branch move leaves noted. That holds however the context
  came to end where it does, through the framework's `undo`, `redo` or
  operator surgery, a host's own move of its branch, or a restart. A gate
  policy that holds `api:inference-request` is the exception: the request
  it lets through later is no retake, and its turn takes the wake's route. A
  retake whose history holds none, and that takes no such note, speaks as
  before.
  Otherwise it is private, even after a channel turn, and even where the
  context now shows that input only in a summary, and its delivery receipt
  says how to publish with a send. A script's wake message is private input,
  as a private surface's message is, when the script's start turn is private
  as the message is stored or injected: a turn that reads it is private, and a
  tool boundary that injects it makes its turn private from there. A retake
  doesn't count it: it reads only the marks above, which mean the same in
  any run. An agent
  derived from, or spawned by, an agent whose turn is open and private, or
  an agent that is such a turn's work (`deriveAgent`, or
  `createEphemeralAgent` with `inherit` or `spawnedBy`, a tune-out reader
  fork included), is that turn's work, and so is an
  ephemeral run handed mail from such work: what it sends is private input
  too, its result, its messages and the notice that a restart interrupted
  it, and its record says so (`AgentRecord.privateTurn`). So is mail an
  agent sends while its own turn is open and private (`sendAgentMessage`).
  A resident whose subagent was started, or handed its words, during a
  private turn gets a private turn when the subagent's outcome lands by the
  framework's own routes (`deliverAgentResult`, or agent mail), a channel
  turn that takes it in at a boundary included, and names a channel to post
  there. An outcome a host writes itself, as a module's `addMessage` with a
  wake of its own, carries no such mark, since a module's write can't
  (#789), and neither does a retry the host creates after the private turn
  has ended, unless its spec carries the first attempt's `privateTurn` or
  names as its parent or spawner an agent that is that turn's work. A
  host that derives or spawns an agent for its own reason while a private
  turn is open gets a result its agent answers privately. A tune-out release
  that a crash left deferred, restored at the next boot, opens its turn as
  before: that turn reads the channel messages the hold kept, not an
  operator's words.

  In locus, hybrid and locked mode, a private turn that holds a channel's message
  tells its resident which channels' messages it holds and that its plain
  speech reaches none of them, in a `[routing]` notice before it replies,
  naming each channel once in the turn. That covers a channel wake its start
  takes in, a gate debounce window's channel messages, and a message one of
  its tool boundaries takes in that addressed the agent or follows up where
  the turn sent, whether the boundary injects it or leaves it to the turn's
  next start. Under `'delivery'`, and in locked mode under either rule, the
  notice that someone addressed the agent from another channel may name a
  channel first, and the turn names it once either way. In
  explicit and disabled mode no channel's message moves where plain speech
  goes, in any turn, so no channel is named.

  A private turn's plain speech is kept private in every mode. In locus,
  hybrid and locked modes its `[delivered]` receipt counts it and says the
  plain speech went to no channel, rather than reporting a failed send.
  Under locked prose routing (`proseRouting: 'locked'`), a private turn
  isn't locked while it's private: the agent's lock stays stored for its
  turns that hold no private input. In a private turn, `prose_locus` with
  no destination says the turn's plain speech stays private and where it
  goes on a turn that holds none, and a move is recorded for those turns,
  leaving the private turn as it is. In every mode, an MCPL server's
  `context/beforeInference` channels for a private turn name no default
  outgoing channel and no incoming message: the server isn't told the turn
  speaks in a channel or answers the latest inbound message, as it was on
  0.30.0, where the turn took the fallback channel. In explicit mode, a
  private turn's unprefixed speech is no longer bounced and held as a draft to
  resend: a notice says it was kept private and how to publish. An envelope
  that bounces in a private turn, because it names no destination, names one
  that doesn't resolve, or can't be delivered, isn't held as a draft either,
  words it adds to an `{{unsent}}` resend included: its notice says the words
  were kept private and how to publish, or, when the send threw, that they may
  have gone out. The draft an `{{unsent}}` resend sent stays open, bare or
  with words added. Where an earlier bounce is still held, the kept-private
  notice says that `{{unsent}}` names that draft, not these words. In every mode, words a send holds back
  are held as drafts, as in any turn. In locus and hybrid mode a send holds
  back speech going where it may have posted, or, when the framework can't
  read where it posted, speech going anywhere. A private turn's unprefixed
  speech, and an envelope of its that names no destination or names one
  that doesn't resolve, are going nowhere, so no send holds them back: they
  are kept private. Speech handlers are told a private turn's speech is
  private (`SpeechContext.nonChannelOrigin`), and the built-in Discord
  module posts none of it and edits its thoughts into no message.

  A private turn's `channel_publish` must name its channel: a call whose
  `channelId` is missing, empty or not a string is refused, a conversation
  fork's included, and the refusal says `channel_list` shows the channel ids,
  to an agent that may call it. So must a script's whose starting turn is
  private, as that turn stands at the call, whichever turn watches the script
  then, a call it makes through `toolsets--act` included, and a host's
  `executeToolCall`, or a module's `ctx.callTool`, that carries a private
  turn's id (`callerTurnId`). Two
  kinds of turn id the framework can't place count as a private turn's,
  failing closed, here and wherever the framework asks whether a turn id is
  a private turn's, a wake's caller turn included: one given out in this process before the framework
  was created, and one no newer than a private turn it has dropped from its
  record of the latest 4,096.
  `channel_publish`'s description says so, so the tool list of every agent
  offered `channel_publish` changes once. The model's call is refused before
  it opens, as the dispatcher's other refusals are, so its result carries
  `refused` (`ToolResult.refused`); a script's reaches the script as an
  Error, and a host's is a failed result. A private turn's `channel_open`
  doesn't move the locus, and in locus, hybrid and locked mode its answer says so.
  Neither does its entering an all-except hold (`focus`, or `tune_out` with
  `scope: 'all-except'`), whose answer says the turn's plain speech stays
  private, a conversation fork's included. The `focus` and `tune_out`
  descriptions name that exception, so the tool list of every resident
  offered them changes once more. Its `sleep`
  announcement isn't posted. When the model refuses (a refusal
  stop), a private turn's refusal reacts on no message, and its failure record
  names no channel.

  The `[routing]` notice for speech with no channel now says it stays on the
  surface the agent was addressed from, if any.

- **Hosts reading `inboundSource`:** a message whose event's
  `metadata.channelId` is only whitespace is now stamped as a surface's
  (`kind: 'surface'`). Before, it got no source stamp.

- **Servers and modules writing message metadata:** a `callerTurnId` key in a
  message a server or module stores, or a `dendrite.privateTurn` mark in one a
  module stores, is now dropped, since only the framework writes them. The
  first drop from each server is logged.

- **A report from a script a turn started, deferred across a restart,** such
  as an update's, counts as private input in the next run, whichever turn it
  was, since that run can't know the turn: the start that reads it is
  private, failing closed, as is the first start after a restart when such a
  report stored before it is unanswered. Later turns and retakes don't count
  it.
