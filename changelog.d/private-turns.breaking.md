- **Module authors whose module stores a channel's message for an
  `external-message` event whose metadata names no `channelId`:** that row is
  now an operator's private message, from a surface with no channel, so the
  turn that holds it speaks in no channel unless the agent names one, and so
  does each later turn while it's unanswered or the newest message (the
  private-turns entry under Changed). Before, that turn's answer went wherever
  plain speech went.
  - **Migration:** name the channel in the event's metadata
    (`metadata.channelId`). For the module's channel messages to make the next
    turn public again once an operator's message has been answered, the row the
    module stores for each names the `channelId` in its metadata, with no
    `kind` and no `system` flag, as the built-in Discord module's rows do.
  - **Unchanged:** a module that delivers console, TUI or API input needs
    nothing, since that input is what this change is for, and nor does a
    channel delivered through an MCPL server. No sibling package needs a new
    version.
