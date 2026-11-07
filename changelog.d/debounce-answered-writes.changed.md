- A debounced batch's `[Gate: …]` line names only the batch's events with no
  message of their own in the window, quoting each, as it did: a module event
  whose response stored no single message, for one. An MCPL channel message or
  push, a heartbeat tick or reminder, and a module event whose response stored
  exactly one message naming no channel are in the window already and get no
  line, where they were counted by channel in one ("N messages in #chan
  (oldest ~Ns ago) — already shown above at arrival; this is a batched wake,
  not new content"), or, for a batch's one message still the newest entry, in
  one handed to the turn's start. A batch of such events alone writes no line.
  So a debounced reminder whose module stored its text no longer has that text
  quoted again in a line, and under conversation routing the trunk, woken for
  a fork's messages it doesn't hold, no longer gets a line saying they were
  shown above.
- The reply judge, and `healthSnapshot()`'s `upcomingWakes`, are told that a
  pending debounced batch whose every event has a message of its own written
  to that agent's window only may wake it (`certain: false`), and so may the
  requests queued or held for it when each reads rows (`readsRow`,
  `readsRows`), since such a wake starts no turn once the agent has answered
  them. A batch with an event that has no message of its own, or one written
  to another agent's window, stays certain, and so does a request that reads
  no row.
- `gate:judge-verdict`'s `woke` still says whether the gate goes on to deliver
  the batch to wake the agent, and such a delivery may now start no turn.
- Wake onboarding's offer describes a suggested `debounce` rule as
  `debounceMs`'s description does: it wakes the agent once after a burst goes
  quiet, unless by the time it would start the agent's turn every event in
  the burst was written for the agent and the agent has read and answered it.
- **Prompt cache:** `wake_add_rule`'s descriptions of `debounceMs` and of its
  judge change, so the first request after the upgrade that carries that
  tool misses the cache from its tool block on.
