- A debounced batch's `[Gate: …]` line names only the batch's events with no
  message of their own in the window, quoting each, as it did: a module event
  whose response stored no single message, for one. An MCPL channel message or
  push, a message-mode heartbeat tick or a reminder, and a module event whose
  response stored exactly one message, for every agent and not held from the
  residents, where neither the event nor the message names a channel and the
  event isn't console or API input, are in the window
  already and get no line, where they were counted by channel in one ("N
  messages in #chan (oldest ~Ns ago) — already shown above at arrival; this is
  a batched wake, not new content"), or, for a batch's one message still the
  newest entry, in one handed to the turn's start. A batch of such events alone
  writes no line when it is delivered. A silent heartbeat tick stores nothing
  and has no text to quote. It was counted in that line too, as a message
  already shown, and now gets no line.
  So a debounced reminder whose module stored its text no longer has that text
  quoted again in a line, and under conversation routing the trunk, woken for
  a fork's messages it doesn't hold, no longer gets a line saying they were
  shown above. Such a module message is stored in the trunk's slot, so a
  conversation fork's own window holds neither it nor, as before, a line
  quoting it.
- A module event whose one message a surgery's hold or an agent's recovery
  keeps in memory when the event arrives is quoted in the line, as one with
  no message is: its message has no stored row yet.
- Where a row a reply could be meant for follows a batched wake's messages in an
  agent's window when the turn the wake starts begins, such as another
  channel's message stored during the batch's quiet period, that fresh start
  writes one `[Gate: …]` line naming them by count and channel, or as having
  none, as the agent's own row, before the start's own notices. A clock row,
  a stored context injection, a row the agent's view leaves out, the batch's
  own line quoting its other events and an unobserved co-resident's own round
  don't count; an observed co-resident's round owed to the agent does, and so
  does the agent's own row, such as its reply in another channel. Past the
  window's 32 newest rows that don't count, the line is written. Each agent
  the batch wakes decides its own line by its own window, once per wake, and
  none is written while the host is quiesced. A window still in legacy mode
  reads its slot's shared record, where only the delivery agent's start
  writes the one line, so a co-resident's turn that starts before it has
  none. A turn that
  merges batched wakes names all their messages, and one that merges a wake
  that isn't a batch's names none. 0.33.0 wrote such a line at the turn's
  start only for a batch of one message still the newest entry when it fired;
  now any batch's start does, and only where something follows its messages.
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
