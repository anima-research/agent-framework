- **The prose bounce-wake cap no longer latches.** A bounce wakes the resident
  so it can resend, at most twice in a row, so a bounce → wake → bounce loop
  ends. The count reset only when a prose envelope was delivered, so a
  resident that recovered from bounces another way (a send tool, setting the
  draft aside) kept the count across turns: from its third bounce on, a reply
  to a fresh message bounced with no wake, and sat unseen until something
  else woke the resident. The count now also resets when a turn starts with a
  cause of its own (a channel message, a server event, a gate flush, a timer,
  an operator nudge), in explicit and hybrid modes. A loop of bounce wakes
  with no other cause is still capped at two.
