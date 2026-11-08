- **Module authors whose module stores a row for an `external-message` event
  whose metadata names no `channelId`, other than an operator's input from a
  console, the TUI or an API call, such as a channel's message or a timer's,
  a webhook's or a service's notice:** that row is now an operator's private
  message, from a surface with no channel, so the turn that holds it speaks in
  no channel unless the agent names one, and so does each later turn while
  it's unanswered or the newest message (the private-turns entry under
  Changed). Before, that turn's answer went wherever plain speech went.
  - **Migration:** name a channel in the event's metadata
    (`metadata.channelId`): for a channel's message, its channel. The turn it
    wakes is then not private on its account, and its answer goes where plain
    speech went before this change. Naming the channel there doesn't send the
    answer to it, since the wake doesn't carry the event's channel. For the
    module's channel messages to make the next turn public again once an
    operator's message has been answered, the row the module stores for each
    names the `channelId` in its metadata, with no `kind` and no `system`
    flag, as the built-in Discord module's rows do.
  - **Unchanged:** a module's console, TUI or API input needs nothing, since
    that input is what this change is for, and nor does a channel delivered
    through an MCPL server. No sibling package needs a new version.
