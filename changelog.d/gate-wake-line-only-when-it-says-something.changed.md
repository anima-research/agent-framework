- A batched (debounced) wake for one MCPL message that is still the newest
  entry in the agent's window runs without its `[Gate: 1 event matched] …
  already shown above at arrival; this is a batched wake, not new content`
  line. The line says which messages a wake is for, and for that one message,
  right above it, it said nothing new: on a resident whose addressed messages
  wake through a 5 s debounce, a third of the window was these lines, four in
  five of them right under the one message they named. The wake itself, its
  provenance and the reply's channel are unchanged. The line stays whenever
  it says something: several messages in the batch, anything stored after the
  message (the agent's own turn, another message), a turn running or a write
  waiting, a message a tune-out holds, and content the line quotes (events
  not stored at arrival). The gate asks the framework (`isNewestEntry`, by
  the message's server, channel and message id, or a push event's event id);
  a gate built without it writes every line, as before. Each wake run without
  its line is traced as `gate:wake-line-omitted`.
