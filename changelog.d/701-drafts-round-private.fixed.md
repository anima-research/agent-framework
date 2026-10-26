- In a round that calls `drafts`, with any action, what the round would hold
  or bounce for lack of a destination is now held as a draft with no notice
  mid-turn (#701). It stays listed by `drafts` and resendable by id, and the
  turn's receipt (in `locus` and `hybrid` mode) or a later turn's catch-up
  notice (in `explicit` mode) names it, but nothing offers it for resend while
  the turn runs. Before, once a turn had an explicit send (a `drafts` resend
  included), such a line was held as a draft and the round's notice offered
  it, so an agent that writes a line beside each call resent its own narration
  round after round within one turn. In a turn a send has silenced, the
  round's plain speech stays in the agent's context instead, counted in the
  receipt as kept private, while what a `>>>` envelope addressed, a refused or
  malformed one included, is held with no notice. A round that also makes a
  send of its own, other than a `drafts` resend, holds its prose and offers it
  as any send's round does. Outside a silenced turn, what the round would
  deliver is still delivered, a `>>`/`>>>` target and a sticky target
  included, and a refused target, a malformed envelope or a failed delivery
  still bounces. This applies in native tool mode, to a `drafts` call made
  from a script too. In `explicit` mode, an envelope beside a script whose
  code mentions `drafts` now waits for the script, since its call would change
  the round's routing. XML tool mode, which routes a turn's prose once at its
  end with no notice mid-turn, is unchanged: there an `explicit`-mode line
  beside a `drafts` call still bounces, and the bounce-wake cap ends a cycle
  of `drafts` resends after two wakes, counted from the last turn with a cause
  of its own or the last delivered envelope.
- Only the framework's own `drafts` tool makes a drafts round: a module's or
  server's tool whose bare name is `drafts`, such as `mail--drafts`, makes
  none, and a resend through it no longer silences its round's prose.
