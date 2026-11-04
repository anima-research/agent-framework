- **Residents:** a turn with no channel whose plain speech a module says it
  showed someone, such as the terminal or page whose message opened the turn
  (`Module.onSpeechRouted`), is no longer told `[send-undeliverable] Your
  previous reply … had no channel to go to` for that speech, and its
  `[delivered]` receipt reads "plain speech → sent to <where the module said>
  · this turn's routing posted it to no channel" (that last clause left out
  when the turn tried a channel post, such as a hybrid `>>>` envelope). A turn
  whose speech went to a channel also has its receipt name where a module
  showed the speech, beside the channel; one whose channel post failed names
  that place in its receipt, and the failed post keeps its own notice. This
  holds under prose routing by locus, hybrid and locked, for each tool round's
  prose as it routes and for the final reply.
- **Hosts:** a routed piece of speech with no channel that a module says it
  showed logs `[routeSpeech] <agent>: turn has no channel; <n> chars shown by
  <places>, routing posted it to no channel` and emits no
  `mcpl:speech-route-failed` trace, where it emitted one; a routed piece no
  module showed emits it as before. `ChannelRegistry`'s `onRouteFailure` info now
  carries `text`, the words routed, so a host that logs that info logs the
  agent's speech.
- **Hosts:** under a provider hold, a merged start and an equal wake keep each
  of their wakes once at the hold's release: a wake equal to one already in
  the start's batch folds into it, as a held turn's equal wakes fold, where
  two equal members of equal merged starts were both kept and
  `getHostModeStatus().gatedRequests` counted both; and a held wake that an
  equal merged start folds into is released with the start's wakes, where it
  was dropped.
- **Residents:** speech routed with no channel that no module says it showed
  still gets `[send-undeliverable]`, which now names the piece by its opening words,
  quoted: `Your plain speech "<opening>" (<n> chars) had no channel to go to
  …`, where it said "Your previous reply (<n> chars)". A long piece's opening
  is cut at the last word within 40 characters, or inside a first word longer
  than that, and marked "…".
- **Residents:** the `[routing]` notice for a turn with no channel that isn't
  locked reads "Your
  plain speech currently has no channel, so routing posts it to no channel.",
  and an addressed-elsewhere notice on such a turn reads "Your plain speech
  has no channel this turn", where each said it "stays in your archive". The
  note for a channel its server declared inbound-only, in the `[routing]`
  notices and in `channel_open`'s result, reads "plain speech there is
  refused, so no channel there posts it", where it said it "stays in your
  archive".
