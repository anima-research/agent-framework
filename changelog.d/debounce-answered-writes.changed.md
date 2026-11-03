- A batched wake's `[Gate: …]` line is written at the first fresh start after
  the batch fires of any agent that reads the window it names, whatever woke
  that agent, not when the batch fires, whenever the batch has an event the
  agent it was written for may have answered by then, and it names only the
  events not yet answered then. A batch answered by then leaves no line, and
  residents who share the window of the agent that answered it still wake
  for it and find none, where a line was written when the batch fired
  before. The lines owed to one start are written as one
  `[Gate: N events matched]` line, in the order their batches fired, each
  channel's messages counted together, where each batch's was written on its
  own. A start writes none while the host is quiesced or another reader of
  the window has a turn alive, and none for a single event that is still the
  newest entry there; they stay owed for the next start. Owed lines are held
  in memory, so a restart between a batch's firing and that start loses
  them. A batch with no such event keeps the rule it had: its line is
  written when it fires, or, for one message still the newest entry then,
  decided by the delivery agent's start.
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
