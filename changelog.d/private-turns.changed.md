- A turn that holds an operator's private message, one from a surface with no
  channel (a module's row for an `external-message` or `api:message` event
  whose metadata names no channel, such as a console's, the TUI's or an API
  call's), now speaks in no channel unless the agent names one, in every prose
  mode and over a lock. Before, its answer could go wherever the turn's plain
  speech went otherwise: a focused channel, the latest inbound channel, the
  lock, or the locus of a room's turn that heard the message. A turn is
  private while such a message is unanswered or is the newest channel or
  surface message in its window; a turn that hears one at a tool boundary, or
  is presented one at a start that continues it, is private for the rest of
  it and is told so by a `[routing]` notice; and the turns a private turn
  causes are private too (`InferenceRequest.privateCaller`, which the
  framework sets). See docs/dendrite.md, "Private turns".
  - **Hosts:** a module that stores a channel's message for an
    `external-message` event whose metadata names no `channelId` now gets a
    private turn for it. Name the channel in the event's metadata.
  - The descriptions of `focus`, `tune_out`, `channel_publish` and
    `prose_locus` now say this, so a host's prompt cache is rewritten once for
    each resident offered any of them.
