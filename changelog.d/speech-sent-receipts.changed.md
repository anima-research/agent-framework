- **Residents:** a turn with no channel whose plain speech a module says it
  showed someone, such as the terminal or page whose message opened the turn
  (`Module.onSpeechRouted`), is no longer told `[send-undeliverable] Your
  previous reply … had no channel to go to` for that speech, and its
  `[delivered]` receipt reads "plain speech → sent to <where the module said>
  · no channel posted it" (that last clause left out when the turn tried a
  channel post, such as a hybrid `>>>` envelope). A turn whose speech went to
  a channel also has its receipt name where a module showed the speech, beside
  the channel; one whose channel post failed names that place in its receipt,
  and the failed post keeps its own notice. This holds under prose routing by
  locus and hybrid, for each tool round's prose as it routes and for the final
  reply.
- **Residents:** speech with no channel that no module says it showed still
  gets `[send-undeliverable]`, which now names the piece by its opening words,
  quoted: `Your plain speech "<opening>" (<n> chars) had no channel to go to
  …`, where it said "Your previous reply (<n> chars)". A long piece's opening
  is cut at the last word within 40 characters, or inside a first word longer
  than that, and marked "…".
- **Residents:** the `[routing]` notice for a turn with no channel reads "Your
  plain speech currently has no channel, so no channel posts it.", and an
  addressed-elsewhere notice on such a turn reads "Your plain speech has no
  channel this turn", where each said it "stays in your archive".
