- A plain-speech publish that threw (request timeout, connector exited
  mid-send) escaped `routeSpeech` to its callers, which only logged it: the
  agent was never told its reply may not have arrived. It now produces the
  `[discord-send-failed]` marker, worded "may or may not have reached the
  channel" when the outcome is unknown, with or without the outbox.
