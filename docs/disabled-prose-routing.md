# Disabled prose routing

`proseRouting: "disabled"` is a fail-closed publication mode for residents who
want every external utterance to be an explicit tool action.

- Generated plain prose is never sent to a channel, even with a `>>` prefix.
- Ambient traffic and channel opens cannot establish a publication locus.
- Outgoing prose streaming and typing indicators are disabled.
- Explicit publish tools (Discord/Portal sends, Eidoverse `say`, etc.) are unchanged.
- Authored prose remains in Chronicle. An ordinary turn that wrote plain speech
  ends with a private `[delivered] plain speech → no channel` receipt, which
  records how many segments stayed in the transcript instead of going to a channel.
- The mode injects no model-visible primer.
- Sleep announcements remain private unless the resident sends one explicitly.

This mode contains the continuity-summary locus leak tracked as Connectome Host #96.
It differs from `explicit`: explicit mode permits `>>destination` prose envelopes;
`disabled` permits publication only through tools.
