- Awareness marks are one-shot. Switching branches, a turn undo, a redo and
  restarts no longer request marks or removals of their own; previously a
  mark followed the branch, removed when the source branch became active and
  re-added when the recovery branch did. Nothing more is sent for a mark
  after three unconfirmed attempts at it, or after a refusal no retry can
  change, and giving up raises a `discord-awareness-delivery` ops alert. The
  README's
  [Live surgery and Discord awareness marks](README.md#live-surgery-and-discord-awareness-marks)
  describes the ledger, its receipts and how acts are ordered.
- A start never activates a surgery's marks. A batch an interrupted surgery
  left is retired at the next start, none of its marks sent; one that had
  marks to apply raises a `discord-awareness-not-scheduled` ops alert that
  names the surgery and the redo that applies them. An interrupted
  suppression's removals are still finished, at the first start on its
  branch. Each of these notices comes before the start records what it
  reports, so a start that doesn't get that record written gives the notice
  again at the next start.
- A ledger write that certifies a body change (a marks activation, a
  completed suppression or a retired batch) now syncs the store first.
  Previously a crash could keep marks active for a rollback the store had
  lost. Every ledger write is now durable too: the file is synced before it
  replaces the ledger, and its directory and that directory's parent after,
  as the framework's recovery files are. Previously an operating system
  crash or a power failure could lose a write the host had already acted
  on. A directory that can't be synced raises the `recovery-sync` ops alert,
  and the write stands. Writes leave the event loop free while the disk
  works: only serializing the ledger runs on it.
- Awareness delivery no longer holds MCPL traffic. Previously every MCPL
  data plane waited at startup, at reconnect, at a runtime
  `connectMcplServer` or `restartMcplServer`, at a tools list change, at
  `resume()`, after each surgery and in `syncDiscordAwarenessMarkers()`
  until every queued mark had been attempted, which at Discord's pace could
  leave the resident deaf for minutes. When that accounting failed, a
  runtime connect or restart failed, and every running server was recycled,
  one without `reconnect: true` closing for good, except while the host was
  stopping. Delivery now runs in the background, and a route that is not
  connected keeps its work queued until it connects. Nothing but startup's
  staged open and `resume()` now opens every MCPL connection's planes, and
  a connection whose §5.3 policy exchange is in flight still stays closed
  through both until its grant exists. The marks a drain
  hadn't sent when `stop()` began stay queued in the awareness ledger, and
  the next start delivers them in the background. A ledger that cannot
  be read still stops startup, as does one in a version this build doesn't
  read: it can hold a suppression whose removals a start must finish before
  the agent's context is served. A runtime connect or restart is refused
  over a ledger that can't be read only for a stdio server with no reaction
  baseline of its own, whose default is derived from the ledger.
