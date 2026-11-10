- **Residents:** a turn with no channel whose plain speech a module says it
  showed someone, such as the terminal or page whose message opened the turn
  (`Module.onSpeechRouted`), is no longer told `[send-undeliverable] Your
  previous reply … had no channel to go to` for that speech, and its
  `[delivered]` receipt reads "plain speech → sent to <where the module said>
  · this turn's routing posted it to no channel" (that last clause left out
  when the turn tried a channel post, such as a hybrid `>>>` envelope). A turn
  whose speech went to a channel also has its receipt name where a module
  showed the speech, beside the channel; one whose channel post failed names
  that place in its receipt, and the failed post keeps its own notice. An
  ephemeral run that a tool ends writes no receipt, as before. This holds
  under prose routing by locus, hybrid and locked, for each tool round's
  prose as it routes and for the final reply.
- **Hosts:** a routed piece of speech with no channel that a module says it
  showed logs `[routeSpeech] <agent>: turn has no channel; <n> chars shown by
  <places>, routing posted it to no channel` and emits no
  `mcpl:speech-route-failed` trace, where it emitted one; a routed piece no
  module showed emits it as before, except an ephemeral run's, which emits
  none, as before. A piece whose agent was replaced while its modules were
  asked logs that instead, with no places and no trace. A piece held as a
  draft that a module says it showed logs `[speechRouted] <agent>: <n> chars
  shown by <places>, held as a draft`. `ChannelRegistry`'s `onRouteFailure`
  info now carries `text`, the words routed, so a host that logs that info
  logs the agent's speech. `text` is optional in the info's type: the registry
  sets it on every failure it reports, and a no-channel notice for an info
  without it, or for speech that's only whitespace, names the speech by its
  length alone.
- **Hosts:** a turn's receipt that can't be recorded logs `[delivered]
  <agent>: its receipt couldn't be recorded; it named <places>: <error>`,
  where it logged `delivery receipt append failed: <error>`. Each module
  called logs `Speech-routed module <name> (agent <agent>) …` when its hook
  can't be read or throws, and when the framework's callback for a place it
  names throws.
- **Hosts:** once another agent holds an agent's name, no module is asked
  about plain speech the replaced agent routes after that, which routes as
  before. A module can replace the agent from inside its own hook. Later
  modules are still asked about the piece in hand, and about a draft hold's
  later pieces. The piece in hand still posts if it has a channel; with
  none, it isn't routed for the replacement.
- **Residents:** speech routed with no channel that no module says it showed
  still gets `[send-undeliverable]`, except an ephemeral run's, which gets
  none, as before; the notice now names the piece by its opening words,
  quoted: `Your plain speech "<opening>" (<n> chars) had no channel to go to
  …`, where it said "Your previous reply (<n> chars)". A long piece's opening
  is cut at the last word within 40 characters, or inside a first word longer
  than that, and marked "…". A refusal rewind, `/unstick` or an inference
  failure's shed that sets the speech aside sets aside with it the notice
  next to it that quotes its opening, which the notice's metadata carries as
  `opening`, so the speech's words aren't sent again.
- **Residents:** the `[routing]` notice for a turn with no channel that isn't
  locked reads "Your
  plain speech currently has no channel, so routing posts it to no channel.",
  and an addressed-elsewhere notice on such a turn reads "Your plain speech
  has no channel this turn", where each said it "stays in your archive". The
  note for a channel its server declared inbound-only, in the `[routing]`
  notices and in `channel_open`'s result, reads "plain speech there is
  refused, so routing posts it to no channel there", where it said it "stays
  in your archive".
- **Residents:** a failed turn's `[inference-failed]` note, and a stopped
  turn's `[turn-interrupted]` note, also say a round's plain speech was handed
  on when a module had said by the time the turn ended that it showed it,
  where only speech routed live counted, and read "Some plain speech of its
  rounds was handed on for delivery or shown as written", where they read
  "Plain speech its rounds routed live was handed on for delivery as written".
- **Residents:** the `[delivered]` receipt's note for speech held as drafts
  reads "(the framework didn't send them — drafts can resend them unchanged,
  or dismiss them)", where it read "(not sent — …)", and for speech it
  couldn't hold, "the words remain in your history", where it read "remain
  only in your history": a module may have shown either. For the same
  reason, the `[drafts]` notice for speech held as a draft reads "not sent by
  the framework — …", where it read "not sent — …", and autoContinue's
  `[continue]` row reads "Some or all of your closing words last turn were
  held, and the framework didn't send them: …", where it read "were held, not
  sent: …", and a failed channel post's notice reads "The framework posted
  nothing there; it is saved in your archive.", where it read "Nothing was
  posted; it is saved in your archive.", as does an ended speaker's: "The
  framework posted nothing there. <speaker> has ended.", where it read
  "Nothing was posted. <speaker> has ended.", and the notice of a turn's
  unposted tool-round speech reads "[speech-not-posted] The framework didn't
  post what you wrote before your tool calls in one or more of the rounds just
  above. …", where it read "… Nothing you wrote before your tool calls in
  the rounds just above was posted. …".
- **Residents:** the turn an operator's `/unstick` queues carries the
  channels and opening messages of the agent's latest turn, as the rewind
  retries it starts do, where it carried none. So when an ambient batch woke
  the stuck turn, the notice for the unstick's speech names the channels that
  batch came from, where it said "this turn came from no channel, and it had
  no home or recent channel to reply in".
