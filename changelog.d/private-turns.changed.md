- A turn that holds an operator's private message, one from a surface with no
  channel (a module's row for an `external-message` or `api:message` event
  whose metadata names no channel, such as a console's, the TUI's or an API
  call's, other than one whose event's `source` begins with `mcpl:`, as the
  framework's notices of a server's new tools do), now speaks in no channel
  unless the agent names one, in every prose mode and over a lock. Before, its
  answer could go wherever the turn's plain speech went otherwise: a focused
  channel, the latest inbound channel, the lock, or the locus of a room's turn
  that heard the message. A turn is private while such a message is unanswered
  or no channel's message in its window is newer. Only a round of
  the agent's that writes words and calls no tool answers it, so an answer
  given only through a tool, such as a send, leaves it unanswered, and so does
  a row under the agent's name that a module stored from outside
  (`metadata.external`), such as the Discord history sync's copy of the
  agent's earlier post. A channel's
  message there is a row whose inbound source is a channel, or a row with no
  inbound source, as a module writes for its channel's message, whose metadata
  names a `channelId`, that has no `kind` and no `system` flag, and that isn't
  a conversation fork's closure prompt. A row tagged as a reaction, an edit, a
  deletion or a `chat:system` notice isn't one, but for an edit delivered as
  the agent's first view of its message. A turn that hears an operator's
  private message at a tool boundary, or is presented one at a start that
  continues it, is private for the rest of it and, unless it's silent or ends
  there, is told so by a `[routing]` notice. In locus, hybrid and locked
  mode, a turn private from its open whose open would otherwise have a
  channel to speak in or, outside locked mode, that a heartbeat woke, is
  told so: by the same notice where its
  window alone, without a wake's mark, would make it private, and otherwise
  by the notice that its plain speech currently has no channel. A private
  turn's delivery receipt there names the plain speech it kept for being
  private apart from what the agent kept by choice.
  Plain speech already waiting for
  a channel to open when the turn turns private still posts there. The turns
  that the framework's own wakes from a private turn open, its auto-continue,
  its ` !` continuation and a prose bounce's resend, are private too
  (`InferenceRequest.privateCaller`, which the framework sets). So are a
  private turn's re-runs, each of which takes the mark from the turn: a
  context-budget restart's continuation, a provider hold's or the error
  policy's retry, a refusal rewind's or `/unstick`'s retry, the
  poisoned-history rewind's retry, and a re-arm. In a private turn,
  an envelope's own words go where they would in any turn, and no envelope
  sets a destination for the turn's later words. `channel_publish` naming no
  channel is refused in a private turn, and its refusal says to name the
  channel. The built-in Discord module posts none of a private turn's speech
  and edits none of its thoughts into a post, and a host's own speech handler
  is told the turn is private and should post none of it either (below). The
  framework's typing indicator shows in no channel, though the built-in
  Discord module's `autoTyping` still types in its reply context's channel in
  a private turn that isn't silent. At a start that's private when its MCPL
  servers' `beforeInference` hooks run, they're told no channel the turn
  speaks in and no message it answers. A start of an agent whose window
  couldn't be written down that turns private only after its hooks, as the
  error policy's retry can, has already told them its channel and the message
  it answers. See docs/dendrite.md, "Private turns".
  - A module that stores a channel's message for an `external-message`
    event whose metadata names no `channelId` now gets a private turn for it
    (under Breaking).
  - **Hosts:** a module that publishes the speech it hears in
    `onAgentSpeech` should post none of it when `SpeechContext.private` is set.
  - The descriptions of `focus`, `tune_out`, `channel_publish` and
    `prose_locus` now say this, so a host's prompt cache is rewritten once for
    each resident offered any of them.
