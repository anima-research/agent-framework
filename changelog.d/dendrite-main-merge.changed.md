- Merged `main` at 0.22.1. The turn-routing rework (#314) is kept whole, and
  `speech.locus` decides what its addressed re-pin does: under
  `'latest-inbound'` a mid-turn addressed message or an *arrival* (one that
  landed between the turn's streams) moves the locus as 0.22.1 does; under
  `'delivery'` (the default) neither moves it, and an arrival that addressed
  the agent from another channel is announced at the turn's next start with
  the same `[routing] … addressed you from …` notice a tool boundary gives,
  naming which start it is: a provider hold, a re-inference on tool
  results, a budget restart or a retry.
  The per-agent routing maps the Dendrite seam read (`turnLocusPins`,
  `turnEngagedChannels`) are gone with the rework; the seam reads the turn's
  `TurnRouting`. `conversationAgentHomes` and `sharedSlotAgents` are answered
  by the agent registry (`homeChannel`, `readsSharedSlot`).
- Merged `main` at 0.22.2. Where main's deferred-write rework (#286) meets
  the Dendrite seam: at a tool boundary, a message held from the residents
  (`tuneOut.heldFromResidents`) is stored with the boundary's other drained
  writes, as before, and left out of the injection, since the next compile
  hides it; a message that can't join the stream waits for the turn's end,
  as main has it, and "the agent's own voice" there is every participant
  the agent presents as, a derived agent's inherited voice included, not
  its name alone. Held agent mail (`sendAgentMessage`, `deliverAgentResult`)
  is released at each of the three sites that now store a deferred write:
  the tool boundary, the turn-start flush and `addMessage`. An arrival's
  record carries `addressed`, so main's new arrival tests read it. The
  all-except hold's timers and option reading follow #444 (see the
  all-except entry). `ProviderWaitNotSleptError` (main) is exported beside
  `AgentStoppedError` and `DeriveAgentOptions` (the branch).
- Merged `main` at 0.22.3. `isAddressedMessage` stays tag-only: main's call
  sites pass the message's metadata as a second argument it ignores, and
  here they pass the tags alone. The channel registry still decides nothing
  about the locus at ingestion: main's acceptance step keeps only its
  confirmation that the transport is open (a lifecycle-directed server's
  traffic confirms the current target alone), and the latest-inbound locus
  is set by admission, as before. `tune_out` and `focus` still dispatch
  through the queue, and `enter` without a reader is still a silent hold;
  main's words for a channel already tuned out, one bound to a conversation,
  a cancel of a channel that isn't tuned out and an empty `speak_in_channel`
  are adopted. A coalesced wake's timer reports what its work throws
  (`tune-out:timer-failed`, main) around the all-except hold's own wake
  path. The `drafts` tool (main) sits beside `tune_out` and `focus`; a
  derived agent's tool block is still its surface owner's, with main's
  `utils` filter applied to it. The deferred-writes restore is main's (a
  queue that can't be read refuses to start; `heldAt`), with the branch's
  re-wake for a tune-out release it restores. A request's per-agent
  settings come from main's `requestSettings()` with the branch's
  `assistantParticipant`; main's request-only rows are rendered under the
  agent's presentation name. `endEphemeralRunRefused` is gone with main's
  refusal of a start during `stop()` (#532). `QuiesceBlockedError` (main)
  is exported beside the branch's names.
  Main's rule that a refusal is an error result (#506) now covers
  `tune_out` and `focus`: every refusal they return is `isError: true`, and
  a channel the registry doesn't know is refused as `unknown channel: <id>`
  (an id on several servers keeps the registry's own words). A tune-out
  with no reader is a silent hold only where the host offers `tune_out`
  without one (`tuneOut.enabled`); the coordinator's new
  `holdWithoutReader` hook says so, and without it a hold with no reader is
  refused in main's words. Under the author rule a placeholder for content
  the host can't read is stored under its author too, `User: [Content not
  shown: …]`, which main's parity test now counts as such.
- Merged `main` at `a4a74b48` (0.26.0 and after), where #710's
  server-qualified channels meet the branch. A conversation fork's home
  stays the agent registry's `homeChannel`, which the framework reads
  wherever main read its own map of homes. `tune_out` and `focus` resolve
  their channel as main's channel tools do: with a `serverId`, that server's
  channel; inside the calling turn, the turn's own channel by its id;
  otherwise the one registered channel a name answers to, by its id or as
  `serverId:channelId`, and a name two channels answer to is refused with
  them as candidates; `check`'s `peek` takes the same names and refuses what
  they refuse, a channel no server registers now included. Their answers,
  and the all-except announcement, name and reach the channel on its server.
  The subconscious's `deliver_summary`, `cancel_tuneout` and
  `speak_in_channel` resolve a channel as main's do, from a reader fork too.
  A `cancel_tuneout` that names the all-except scope ends that hold, as
  before, whatever channel its `channelId` picks or fails to pick (a name two
  servers' channels answer to, or a turn's own channel its server no longer
  registers); only a channel with a tune-out of its own is cancelled instead.
  The latest delivered
  inbound message, which admission records, keeps its server, and a message
  whose server no longer registers its channel sets none. A
  `channel_publish` naming no channel takes the turn's locus only when the
  call is made inside the turn; outside it, a conversation fork's goes to
  its home, and anyone else's takes the registry's default. So main's
  shared-channel-ids entry, which says such a publish posts to the latest
  message's channel, holds here only under `speech.locus:
  'latest-inbound'`, for a call made outside a turn or in a turn with
  neither a locus nor a trigger channel. Every way a live non-ephemeral agent ends drops a continuation
  of its turn that is on its way (#722), and a conversation agent stopped by
  a listener of the failure its hold after the compile reports is held by
  nothing.
