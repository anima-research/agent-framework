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
- **Outgoing streams follow the same rule.** A stream goes only to a
  declared channel, names its place, and is skipped when the route is a
  thread, since one channel's stream can't name two places.
- **Publishing rechecks after opening.** When a publish has to open a closed
  channel first, it checks the destination again before sending: a channel
  removed, or a declaration withdrawn, while the open was pending refuses the
  send, rather than relying on the connector to.
- Refusal results (`delivered: false` with a `reason` and no message) keep
  the connector's reason.
