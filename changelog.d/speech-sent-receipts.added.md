- `Module.onSpeechRouted(agentName, text, context)`: called as a turn routes
  each piece of its plain speech, in routing order, or holds one as a draft,
  which can be after later pieces have routed (prose routing by locus, hybrid
  or locked, on a host with a channel registry). For a piece no channel
  takes, a surface may show it then. Return a `SpeechSent`, `{ sentTo }`,
  when the module showed that text to someone; the turn names the
  place in its receipt and, with no channel, writes no undeliverable notice
  for it. The place reads as one line, each whitespace run as one space and
  none at either end, and an opening of a tag the framework marks in text it
  supplies, its own notice tags and those of context-manager and membrane,
  such as `[routing]` or `[Recall]`, reads with a backslash before it.
  Return `{}` otherwise: the notice then still says another
  surface may have shown it. A piece held as a draft gets no such notice,
  since it's named as a draft. The call is synchronous, and routing goes on
  when it returns, so showing a piece is a write that doesn't wait; a module
  that throws names no place. A piece with `final: true` comes after the
  turn's `inference:completed` trace and before the agent's next
  `inference:started`. Private envelopes and words kept private, explicit
  sends (prefixed envelopes included) and their own words held as drafts,
  turns under explicit routing, which write no receipt, and an ephemeral
  run's speech with no channel that it doesn't try to hold as a draft, which
  is its caller's result, are never asked about.
- `SpeechRoutedContext`: `final` (the turn's final reply: its speech after
  its last tool call, a refused XML attempt or a call cut off unrun being
  none), `turnId`, and
  `openedBy`, the request that opened the turn, kept across a
  context-budget restart, with `messages`: the messages added by the module
  answers whose wakes the turn took, and, for a turn the framework queued to
  carry another on (a `!` continuation, an autoContinue run, a bounce's
  wake, or a retry on a history rewound after a refusal, an unstick or an
  inference failure), the messages that opened that turn, as stored ids
  that a module context's `getMessage` reads (a message kept in memory when
  its wake was asked for, while a surgery's hold or its agent's recovery
  keeps the write, has no id yet and isn't named); a turn that
  took a cause of its own that brought messages beside such a continuation
  before any of its rounds reached its tool calls names that cause's messages
  instead, and a cause that
  joins a turn already under way is named beside the turn's own. A message a
  rewind removed is still named, and `getMessage` returns `null` for it.
