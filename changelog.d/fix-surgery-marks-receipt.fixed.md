- Live `rollbackToMessage` and `suppressMessages` (and message-granular
  `host/command` undo, which rides on rollback) return once the body change
  has landed, with a marker-scheduling receipt, instead of after every 💤
  reaction has been delivered. Previously the store stayed
  reserved, and the operator got no answer, for the whole serial drain: about
  15 minutes for a rollback that removed 918 channel messages. Delivery now
  continues in the background, behind the same MCPL data-plane gate as
  before. The result's new `markers` field (`none` | `queued` |
  `not-scheduled` | `unresolved`) says whether marks were scheduled, never
  that Discord accepted them. If the ledger write after the switch fails, the
  rollback that already applied is no longer reported as failed: the batch is
  retired (`not-scheduled`), or, if even that write fails, the result says
  the batch may still be delivered (`unresolved`). A suppression whose
  redactions all committed is no longer undone by that failure.
