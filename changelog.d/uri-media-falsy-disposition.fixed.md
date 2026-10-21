- A uri-form image or audio block that gives a `disposition`, even a falsy one
  such as `0`, `false`, `""` or `null`, becomes a reference stub in pushed
  events, channel messages and context injections, as one with `"ref"` or
  `"never"` does, and as tool results already showed it. Before, such an image
  went to the provider with its `uri` as the image's source, except in a
  `system` injection, which can't carry an image, and such audio showed the
  no-data notice. A reference's own reading of the block, and the check for
  inline data that claims a disposition, already counted any disposition
  given. Pushed events and channel messages are converted once, when they're
  accepted or a coalesced one is delivered, and stored that way, so history
  from before the upgrade keeps such a block as it was: an image there stays
  a provider url source while its message is in context. A server's
  `beforeInference` injection is converted at each turn, so one that keeps
  injecting such a block changes there at the first turn after the upgrade,
  whose first request misses the prompt cache from that injection on: from
  the system prompt on, for a `system` injection. As for a `"ref"` block, the
  stub names a reference id this host keeps only in memory, so the same miss
  comes again after each restart.
