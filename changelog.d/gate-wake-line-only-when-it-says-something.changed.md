- A batched (debounced) wake for one MCPL message that is still the newest
  entry in the agent's window runs without its `[Gate: 1 event matched] …
  already shown above at arrival; this is a batched wake, not new content`
  line. The line says which messages a wake is for, and for that one message,
  right above it, it said nothing new: on a resident whose addressed messages
  wake through a 5 s debounce, a third of the window was these lines, four in
  five of them right under the one message they named. The wake itself, its
  provenance and the reply's channel are unchanged. The line stays whenever it
  says something: several messages in the batch, anything stored after the
  message (the agent's own turn, another message), a turn running or a write
  waiting, a message a tune-out holds, and content the line quotes (events not
  stored at arrival). The gate asks the framework (`isNewestEntry`, by the
  message's server, channel and message id, or a push event's event id); a
  gate built without it writes every line, as before. A clock row stored after
  the message doesn't count against it. The gate asks when the batch fires,
  and the turn compiles later: a provider hold or a compression in flight can
  leave room for another message to be stored in between. So when the message
  is still the newest at the fire, the gate hands the line to the wake, and
  the turn's start decides, after its own inputs land: if anything is stored
  after the message by then, the line is written there, after what arrived and
  before the start's own notices, with the same words and its age counted to
  then, once, at the start of the agent the window belongs to, before its
  answer. Another resident reading that window places none (every resident
  gets every batched wake), so its request shows what the window holds, as
  before. No start writes one while the host is quiesced or another resident
  reading that window has a turn alive, where it would land inside that turn,
  as a clock row waits then too; that start's request goes without it, and it
  is written only if another fresh start of the wake comes. A line left out is
  decided again if the provider holds the turn and its fresh start runs later;
  if the first start's own notices then follow the message, as a routing
  notice does when the turn's channel changed, the line is written. A retry of
  the same start decides nothing. Each fresh start that leaves a line out
  traces `gate:wake-line-omitted`, with its reason (`newest` or `held`); a
  line whose write fails is logged and left for a later start. A turn that
  never starts for the wake, or one that starts as the continuation of a turn
  already running, writes no line and traces none.
