- A batched wake's `[Gate: …]` line, for a batch whose every event the host
  wrote to the delivery agent's window (`after`, with its message's id), is
  written at the first fresh start after the batch fires of any agent that
  reads that window, whatever woke that agent, not when the batch fires, and
  it names only the events not yet answered then. A batch answered by then
  leaves no line, and residents who share the window still wake for it and
  find none, where a line was written when the batch fired before. The lines
  owed to one start are written as one `[Gate: N events matched]` line: its
  quoted events in the order their batches fired, then each channel's
  messages, counted together under each name the channel was shown by, where
  each batch's line was written on its own. A start that finds the host
  quiesced or another reader of the window with a turn alive writes none, and
  the next start of any reader decides them again. A line left out because its one
  event, a channel message or a push, is still the newest entry there is
  decided again only by the delivery agent's later starts of its wake, as a
  newest message's line is, and so is the line of an event written to another
  agent's window. Owed lines are held in memory, so a restart between a
  batch's firing and that start loses them. Any other batch's line is written
  when it fires, and a single message still the newest entry then is handed
  to the delivery agent's start, as before.
- A batch partly answered by its turn's start keeps the route the whole
  batch chose: its turn speaks in the channel of its newest addressed event
  even when that event is answered and the line names only the others.
- The reply judge is told that a pending debounced batch whose lines are
  handed to the wake, and the requests queued for the agent, only may wake
  it (`certain: false`) when every message each names was written to that
  agent's window, since such a wake starts no turn once the agent has
  answered them. An event given no write or written to another agent's
  window, or a queued request that names no message, keeps it certain, and
  so does a batch that wakes more than one agent.
- `gate:wake-line-omitted` is traced at the start of any agent that reads the
  window, for each line still owed there that the start leaves out as newest
  or for a held slot, each time, where it was traced only at the delivery agent's starts of the line's
  own wake.
- `gate:judge-verdict`'s `woke` still says whether the gate goes on to deliver
  the batch to wake the agent, and such a delivery may now start no turn.
- Wake onboarding's offer describes a suggested `debounce` rule as
  `debounceMs`'s description does: it wakes the agent once after a burst goes
  quiet, unless by the time it would start the agent's turn every event in
  the burst was written for the agent and the agent has read and answered it.
- **Prompt cache:** `wake_add_rule`'s descriptions of `debounceMs` and of its
  judge change, so the first request after the upgrade that carries that
  tool misses the cache from its tool block on.
