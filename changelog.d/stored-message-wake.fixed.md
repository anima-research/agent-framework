- A message stored as it arrived, rather than held for a turn that was
  running, no longer starts a turn of its own when a request read and
  answered it while its wake waited, as behind a context-budget restart or
  a tool-result guard's retry held by a provider. Its wake is now judged as
  the wake of a message heard mid-turn is: it's dropped once a request that
  carried the message has been answered and, for a wake that carries a
  channel, unless its server marked the message ambient, the agent has
  since published into that channel. It's also dropped once the message is
  no longer on its store's current branch. A wake whose message reached the
  agent only in a request that failed, or whose channel the agent hasn't
  spoken in since it read the message, still starts its turn. It covers the
  same wakes: channel messages other than a conversation fork's, push
  events, a module event's one message, background-script wakes and the
  gate's self-wake notices. Only the agent the message was stored for has
  its wake judged this way: another resident's wake for a message in the
  shared slot still starts its turn.
