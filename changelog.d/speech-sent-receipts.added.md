- `Module.onSpeechRouted(agentName, text, context)`: asked as a turn routes
  each piece of its plain speech (prose routing by locus or hybrid, on a host
  with a channel registry), in routing order. Resolve to a `SpeechSent`, `{
  sentTo }`, when the module showed that text to someone; the turn names the
  place in its receipt and, with no channel, writes no undeliverable notice
  for it. Resolve to `{}` otherwise: the notice then still says another
  surface may have shown it. Modules are asked together, and their answers
  about each piece are waited for at most `SPEECH_RECEIPT_WAIT_MS` (5 s,
  exported). A piece with a channel posts without waiting for its own answers;
  since a turn's pieces route in order, a post after a piece with no channel
  waits behind that piece's answers, only while a module hasn't answered. The
  turn's `[delivered]` receipt waits up to the same bound for answers still
  due. Private envelopes, explicit sends and a heartbeat's held prose are
  never asked about.
- `SpeechRoutedContext`: `final` (the turn's final reply: its speech after
  its last tool call, a refused XML attempt or a call cut off unrun being
  none), `turnId`, and
  `openedBy`, the request that opened the turn, kept across a
  context-budget restart, with `messages`: the messages of every wake the
  turn took, as stored ids or held-write handles that a module context's
  `getMessage` reads.
