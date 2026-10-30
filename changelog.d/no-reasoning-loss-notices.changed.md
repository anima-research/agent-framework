- An agent is no longer told when reasoning leaves its context. #826's
  `[reasoning] <agent>:` notices ("The reasoning behind your earlier replies is
  no longer in your context, because your tools changed… Re-read before relying
  on an earlier decision.", and the per-reply form) are no longer stored for an
  agent or passed to its stream, on a binding compile's strip or on a block the
  provider drops. Standing or recurring text about the mechanics of an agent's
  own memory and reasoning gives it nothing to act on and keeps it thinking
  about it, and under a binding model any change to the tool list would have
  triggered one. Operators keep the `thinking-binding-loss` ops alert for drops
  the record doesn't account for, and hosts can still observe strips through
  `Agent.onThinkingStrip`.
