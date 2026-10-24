- **Hosts with a private surface beside channels** (a WebUI, TUI, CLI,
  headless, or an `api:message` naming no channel, on an agent that also
  hears channels): a channel message that meets private input in one turn
  gets no inferred reply in its channel. That covers one batch, one gate
  debounce window, a private surface's message stored before the start, and
  a private turn that a channel's wake continues or that one of its tool
  boundaries brings the message into. The turn is private. A `[routing]`
  notice tells its resident which channels' messages the turn holds, and
  that its plain speech reaches none of them, so the resident can answer
  there with an explicit send, or with a `>>` or `>>>` envelope in explicit
  or hybrid mode. Before, the turn's plain speech went to the channel, with
  the private input in its context.
  - **Who needs to act:** a host that counts on every addressed channel
    message getting a reply of its own, when its operators talk to the same
    agent through a private surface.
  - **Migration:** nothing to change in code. The resident answers such a
    message with an explicit send, as the notice says.
  - **Unchanged:** a start that holds no private input replies in its
    channel as before, and so does a channel's later turn after a private
    one.
