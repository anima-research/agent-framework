- `Module.onSpeechRouted(agentName, text, context)`: asked as a turn routes
  each piece of its plain speech, in routing order, or holds one as a draft,
  which can be after later pieces have routed (prose routing by locus, hybrid
  or locked, on a host with a channel registry). Resolve to a `SpeechSent`, `{
  sentTo }`, when the module showed that text to someone; the turn names the
  place in its receipt and, with no channel, writes no undeliverable notice
  for it. Resolve to `{}` otherwise: the notice then still says another
  surface may have shown it. A piece held as a draft gets no such notice,
  since it's named as a draft. Modules are asked together, and their answers
  about each piece are waited for at most `SPEECH_RECEIPT_WAIT_MS` (5 s,
  exported) from each hook's call; a hook that blocks synchronously past it
  and returns its answer still has it taken. A piece with a channel posts without waiting for its own answers;
  since a turn's pieces route in order, a post after a routed piece with no
  channel waits behind that piece's answers, only while a module hasn't answered. The
  turn's `[delivered]` receipt waits up to the same bound for answers still
  due. Private envelopes and words kept private, explicit sends (prefixed
  envelopes included) and their own words held as drafts, turns under explicit
  routing, which write no receipt, and an ephemeral run's speech with no
  channel that it doesn't try to hold as a draft, which is its caller's
  result, are never asked about. Answer
  from what the module already holds: for a turn that ends with its reply or
  a tool, the turn's receipt and the agent's next turn wait for every answer,
  each piece's up to the bound, and a routed piece with no channel waits for
  its answers before the next piece routes, so a turn of several such pieces
  can wait that long for each; only the turn's receipt waits for a held
  piece's answers. A turn that fails or is stopped writes no receipt
  and doesn't wait. A turn that had finished when `stop()` began still routes
  its speech, and `stop()` waits for those answers in the same way, except
  an ephemeral run's, whose stream its run's end leaves to finish on its own:
  when its reply ends the run, its receipt can come after the run returns, and
  a `stop()` before it comes loses it; when a tool ends it, it writes no
  receipt, as before, and a place a module names for its speech is logged.
- `SpeechRoutedContext`: `final` (the turn's final reply: its speech after
  its last tool call, a refused XML attempt or a call cut off unrun being
  none), `turnId`, and
  `openedBy`, the request that opened the turn, kept across a
  context-budget restart, with `messages`: the messages added by the module
  answers whose wakes the turn took, and, for a turn the framework queued to
  carry another on (a `!` continuation, an autoContinue run, a bounce's
  wake, or a retry on a history rewound after a refusal, an unstick or an
  inference failure), the messages that opened that turn, as stored ids or
  held-write handles that a module context's `getMessage` reads; a turn that
  took a cause of its own beside such a continuation before any of its rounds
  reached its tool calls names that cause's messages instead, and a cause that
  joins a turn already under way is named beside the turn's own. A message a
  rewind removed is still named, and `getMessage` returns `null` for it.
