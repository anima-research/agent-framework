- In a round that calls `drafts`, with any action, words that would be held
  as a draft or bounced for lack of a destination now stay in the agent's
  context instead, and in `locus` and `hybrid` mode the turn's receipt counts
  them as kept private (#701). Before, once a turn had an explicit send (a
  `drafts` resend included), such a line was held as a draft, and the round's
  notice offered it for resend, so an agent that writes a line beside each
  call resent its own narration round after round within one turn. A turn
  silenced by a send holds a round's envelopes too, so there a drafts round
  keeps all its words, while its envelopes still move the router. Outside a
  silenced turn, what the round would deliver is still delivered, a
  `>>`/`>>>` target and a sticky target included, and a refused target, a
  malformed envelope or a failed delivery still bounces. So in `explicit`
  mode, while the turn has no destination, an unprefixed line beside a
  `drafts` call is kept in context, with no bounce or resend offer. This
  applies in native tool mode, to a `drafts` call made from a script too. XML
  tool mode, which routes a turn's prose once at its end with no notice
  mid-turn, is unchanged: there an `explicit`-mode line beside a `drafts` call
  still bounces, and the bounce-wake cap ends a cycle of `drafts` resends
  after two wakes, counted from the last turn with a cause of its own or the
  last delivered envelope.
