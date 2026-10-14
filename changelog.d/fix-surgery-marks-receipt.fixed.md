- Live `rollbackToMessage` and `suppressMessages` (and message-granular
  `host/command` undo, which rides on rollback) return once the body change
  has landed, with a marker-scheduling receipt, instead of after every
  awareness reaction (💤 by default) has been delivered. Previously the store
  stayed reserved, and the operator got no answer, for the whole serial
  drain. At the reported pace of about one reaction per second, 918 queued
  marks would take roughly 15 minutes; the household's client timed out
  after 60 seconds. Delivery now continues in the background, behind the
  same MCPL data-plane gate as before, which holds channel traffic that
  arrives after it until the marks are attempted, or deferred when their
  server isn't connected. A turn may now run during delivery when it carries
  no channel traffic, such as a scheduler timer or a provider admission, and
  also when its channel traffic was admitted before the gate went up (queued
  when the surgery began, or arriving during its switch or fork). Such a
  turn used to wait for the whole drain, since the store stayed reserved;
  now it can answer before the marks show.
- The other branch moves no longer wait for Discord either: the web API's
  `branch.switch`, `undo` and `redo`, and `host/command` turn undo, return
  once the branch has moved, and their marks follow behind the same gate.
  Each starts its delivery through
  `startDiscordAwarenessDelivery(after, agentName?)`, a new public method
  that a host can call after its own branch moves. A delivery that fails to
  start raises a `discord-awareness-delivery` ops alert instead of failing
  the command, and the next sync, reconnect or start delivers what is still
  pending. (The web switch used to await the awareness sync before
  answering.)
- A gate installed while a drain is still running (restoring the source
  branch mid-delivery, say) waits for that drain and then drains again from
  the ledger. So before traffic is released, every mark pending when the
  gate was armed is attempted, or deferred until its server is connected,
  as before: the drain's remaining reactions, the removals they need, and an
  add re-pended during the drain (a rollback, its undo, then a redo).
  Inbound MCPL handlers wait out a generation installed while they wait, not
  only the one they first saw, and a reconnect's gate opens only once both
  its drain and the server's re-registration attempt have settled. So a
  reconnect's `mcpl:server-reconnected` and `module:added` traces now come
  once that attempt has settled, granted or not, where they came at once
  when no marks were pending.
- The result's new `markers` field (`none` | `queued` | `not-scheduled` |
  `unresolved`, the exported `SurgeryMarkerReceipt` type) says whether marks
  were scheduled, never that Discord accepted them. The `[operator]` stderr
  line gains `marks=…` and the operator-actions log entry gains `markers`.
  If the ledger write after the switch fails, the rollback that already
  applied is no longer reported as failed: the batch is retired
  (`not-scheduled`, with a `discord-awareness-not-scheduled` ops alert), or,
  if even that write fails, the result says the batch may still be
  delivered (`unresolved`, with a `discord-awareness-unresolved` ops alert). A
  suppression whose redactions all committed is no longer undone by that
  failure.
