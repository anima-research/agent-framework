- In `locus` and `hybrid` mode, an explicit send now holds plain speech back
  only where the send may have posted. Before, a round with any send
  (`send_message`, `reply_message`, `send_dm`, `channel_publish`, a `drafts`
  resend, a world's `say` or `whisper`) held that round's plain speech as
  drafts, and every later round's until a new message arrived, wherever it was
  going: a line to the person in the conversation, written beside a send into
  another channel, was held as a draft instead of reaching them. Now a round
  with a send routes its plain speech once its sends have answered, and holds
  a segment only where a send may have posted to that segment's own target:
  the turn's locus, or in `hybrid` mode the sticky target or a `>>>` target.
  Where a send posted is read from its answer: a server's success answer whose
  JSON names the channel (`channelId`), or, for `channel_publish` and a
  `drafts` resend, the framework's own publish outcome, which counts as posted
  when delivered or unconfirmed. A send whose answer is an error, or names no
  channel (a world's `say`, a server that doesn't report it), holds the
  round's speech wherever it was going, as before. A send the framework
  refused, or whose publish is proven not posted, holds nothing. The hold
  lasts for the rest of the turn, for speech to the places a send may have
  posted, until a new message reaches the resident. A script's sends count by
  their answers too, and a send still out when its `code_execution` call
  returns counts as one that may have posted anywhere; in XML tool mode, which
  routes a turn's speech once at its end, the places of all the turn's sends
  count. A `drafts` round keeps the speech its resend silenced, as before
  (#701), and its narration aimed elsewhere now goes.
- The costs: a round with a send waits for the send's answer before its speech
  goes, so a send that hangs holds its round's speech until the tool's own
  timeout; narration beside a send to another channel, such as "posting it to
  the other channel now", now reaches the conversation; and a world's `say`
  still holds its round's speech, since its answer names no channel.
- The held-draft notice now names the send, where it posted or may have
  posted, and where the speech was going, or says the framework can't tell
  where the send posted and why; for a send in an earlier round of the turn it
  says the hold lasts until a new message arrives or the turn ends. Its resend
  example names the place the speech was going instead of `"#channel"`. A held
  draft's note now records where it was going, which `drafts` `read` shows.
  For such a draft, `list` and the catch-up notice now give "explicit send in
  its turn" as the reason, and `read` "an explicit send in its turn held it
  back", where each said the send was in the same round. The `drafts` tool's
  description says a draft was held back because an explicit send in its turn
  may already have posted where it was going.
