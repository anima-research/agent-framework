- **Hosts with a private surface beside channels** (a WebUI, TUI, CLI,
  headless, or an `api:message` naming no channel, on an agent that also
  hears channels): a channel message that meets private input in one turn
  gets no inferred reply in its channel. That covers one batch, one gate
  debounce window, a private surface's message stored before the start,
  and a private turn that a channel's wake continues or that one of its
  tool boundaries brings the message into. The turn is private. In locus
  and hybrid mode, a `[routing]` notice tells its resident which channels'
  messages the turn holds, and that its plain speech reaches none of them,
  so the resident can answer there with an explicit send, or in hybrid
  mode with a `>>>` envelope. A message whose wake is dropped once the
  turn has read and answered it, as an ambient or system message's is,
  starts no turn, so the notice may not name its channel; on `main` such a
  message gets no reply of its own either. In explicit and disabled mode no
  channel's message moves where plain speech goes, so none is named.
  Before, the turn's plain speech went to the channel, with the private
  input in its context. An operator's `nudge` or `unstick`, or the API's
  `inference.request`, is private too while the agent's stored history
  (for an ordinary resident, the resident slot it shares with other
  ordinary residents) holds a private surface's message, even right after a
  channel turn: an `unstick` asked in a room posts its outcome notice there,
  and the answer reaches no channel. A gate policy that holds
  `api:inference-request` makes the request it lets through later no
  retake, so the turn it wakes takes the wake's route. The answer to what a
  subagent or fork started, or handed an operator's words, during a private
  turn sends back by `deliverAgentResult` or agent mail is private too, a
  channel turn that takes it in included.
  - **Who needs to act:** a host that counts on every addressed channel
    message getting a reply of its own, on an `unstick` or `nudge`
    answering in its channel (for ordinary residents, whose stored history
    is the resident slot they share, whichever resident the operator
    addressed), or on a subagent's outcome being answered in a channel,
    when its operators talk to the same agent through a private surface. A
    host with a private surface needs to keep its gate from holding
    `api:inference-request`.
  - **Migration:** nothing to change in code. The resident answers such a
    message with an explicit send, as the notice says.
  - **Unchanged:** other than a retake, a start that holds no private input
    replies in its channel as before, and so does a channel's later turn
    after a private one, unless its message arrived while the private turn
    was open. What's private is the turn, not the operator's words: that
    later turn's context still holds them.
