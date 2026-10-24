- A message that arrives while an agent's turn is alive, and that the turn
  hears at a tool boundary, no longer also starts a turn of its own after
  that turn when nothing is left for it (#264). When the scheduler comes to
  start its wake, the wake is dropped if a request that carried the message
  has been answered and, for a wake that carries a channel, unless its
  server marked the message ambient, the agent has since published into that
  channel: in its plain speech, with a `>>` or `>>>` address, in a sleep's
  announcement, with `channel_publish`, by resending a draft, or with a send
  tool whose channel the framework records (`send_message`, `reply_message`,
  `send_dm`, `send_file`, `send_files`). A script's publish counts only in
  the turn that started the script, and as made having read what the agent
  had read when it started. Such a wake whose channel the agent hasn't
  spoken in since the message was read still starts its turn, and so does
  one whose message reached the agent only in a request that failed. A
  message its server marked ambient asked nothing of the agent, so its wake
  is dropped once a request that carried it has been answered; one with
  neither tag is judged as addressed. This covers channel messages, push
  events, a module event's one message, background-script wakes and the
  gate's self-wake notices. Console and API input, a module event that adds
  several messages or whose event or message names a channel, a prose bounce
  notice and a tune-out cancellation keep their wakes. A render's wake to
  read it counts the render as read on the same terms: one that carries a
  channel now also waits for the agent to publish there, unless every notice
  the render folds was marked ambient, and then it's dropped once read, as
  before. `EventGate`'s `addMessage` and `requestInference` hooks take an
  optional `placement` and `after` (`WritePlacement`), which a host that
  builds its own gate passes on to have the self-wake notice's wake dropped
  too.
