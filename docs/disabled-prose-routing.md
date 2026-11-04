# Disabled prose routing

`proseRouting: "disabled"` is a fail-closed publication mode for residents who
want every external utterance to be an explicit tool action.

- Generated plain prose is never sent to a channel, even with a `>>` prefix.
- Ambient traffic and channel opens cannot establish a publication locus.
- Outgoing prose streaming is disabled.
- A turn shows a typing indicator in the channel its wake names, as an explicit
  mode turn does: the channel of the message that woke it. It says the
  resident is attending to that message, whether or not anything is then sent
  there. A turn woken by ambient traffic the gate batched, a heartbeat or a
  silent wake shows none, and so does a conversation fork that a gate batch
  wakes for another channel's message. Typing is all this gives the channel:
  the turn's stream traces (`inference:tokens`, `inference:content_block`)
  still name no channel.
- Explicit publish tools (Discord/Portal sends, Eidoverse `say`, etc.) are unchanged.
- Authored prose remains in Chronicle. An ordinary turn that wrote plain speech
  ends with a private `[delivered] plain speech → no channel` receipt, which
  records how many segments stayed in the transcript instead of going to a channel.
- The mode injects no model-visible primer.
- Sleep announcements remain private unless the resident sends one explicitly.

This mode contains the continuity-summary locus leak tracked as Connectome Host #96.
It differs from `explicit`: explicit mode permits `>>destination` prose envelopes;
`disabled` permits publication only through tools.
