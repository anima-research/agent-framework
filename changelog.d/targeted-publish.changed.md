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
  - `channel_open` on an undeclared channel still opens it, but sets no
    speech target, and its result explains why.
- **Outgoing streams follow the same rule.** A stream goes only to a
  declared channel, names its place, and is skipped when the route is a
  thread, since one channel's stream can't name two places.
- Refusal results (`delivered: false` with a `reason` and no message) keep
  the connector's reason.
