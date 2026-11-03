- A batched wake's `[Gate: …]` line, for a batch whose every event the host
  wrote to a window (`after`), is written at the first fresh start after the
  batch fires of any agent that reads that window, whatever woke that agent,
  not when the batch fires, and it names only the events not yet answered
  then. A batch answered by then leaves no line, and residents who share the
  window of the agent that answered it still wake for it and find none,
  where a line was written when the batch fired before. The lines owed to one
  start are written as one `[Gate: N events matched]` line, in the order their
  batches fired, each channel's messages counted together, where each batch's
  was written on its own. A start that finds the host quiesced or another
  reader of the window with a turn alive writes none, and the next start of
  any reader writes them. A line left out because its one event is still the
  newest entry there is decided again only by the delivery agent's later
  starts of its wake, as a newest message's line is. Owed lines are held in
  memory, so a restart between a batch's firing and that start loses them.
  Any other batch's line is written when it fires, and a single message
  still the newest entry then is handed to the delivery agent's start, as
  before.
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
- `gate:judge-verdict`'s `woke` still says whether the batch was delivered to
  wake the agent, and such a delivery may now start no turn.
- **Prompt cache:** `wake_add_rule`'s `debounceMs` description changes, so the
  first request after the upgrade that carries that tool misses the cache
  from its tool block on.
