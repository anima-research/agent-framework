- **A thread can be a speech route, where its connector posts into named
  threads.** A conversation in a thread is routed into that thread when its
  channel declares `exact` (MCPL RFC-011), and the routing notice and the
  `[delivered]` receipt name the thread.
  - On a channel that declares `root`, a thread is a contradiction. The turn
    records it as unroutable, and speech is held rather than posted to the
    root.
  - An undeclared channel is unroutable as `untargetable`.
  - Gate-batched wakes now carry each event's thread, so a thread and its
    channel's root are different conversations on every path.
- **Residents can choose a thread deliberately.**
  - `channel_publish`, `drafts.resend` and `channel_open` (with
    `setSpeechTarget`) take an optional `threadId`.
  - A channel named without one means its root, never a thread borrowed from
    an earlier route.
  - A supplied selector is checked before any default applies: an empty or
    non-string `threadId` or `serverId` on `channel_open`, or a non-boolean
    `setSpeechTarget`, is refused with nothing opened, and a conversation
    fork's empty `channelId` is refused rather than read as its home.
  - `channel_open` on an undeclared channel still opens it, but sets no
    speech target, and its result explains why.
- **Outgoing streams carry only published speech.** A channel's outgoing
  stream (MCPL §14.3) now carries prose once a publish has confirmed it, at
  the channel's root, on the server and channel that publish resolved; it no
  longer streams words while they are generated. A later call in the same
  round can still make them private (a same-round private `think`, a
  `skip_reply`), held (an explicit send's silence) or unsent, so held,
  private, failed and unconfirmed words never stream, and a voice surface
  speaks only what was posted. A thread placement isn't streamed, so a
  channel's stream names one place. Each physical stream completes, after its
  last speech, exactly what it streamed. Voice therefore follows each
  published round rather than overlapping generation; speech still lands
  between tool rounds.
- **Publishing rechecks after opening.** When a publish has to open a closed
  channel first, it checks the destination again before sending: a channel
  removed, or a declaration withdrawn, while the open was pending refuses the
  send, rather than relying on the connector to.
- Refusal results (`delivered: false` with a `reason` and no message) keep
  the connector's reason.
