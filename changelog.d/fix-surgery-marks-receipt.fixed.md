- Live `rollbackToMessage` and `suppressMessages` (and message-granular
  `host/command` undo, which rides on rollback) return once the body change
  has landed, with a marker-scheduling receipt, instead of after every 💤
  reaction has been delivered. Previously the store stayed reserved, and the
  operator got no answer, for the whole serial drain. At the reported pace
  of about one reaction per second, 918 queued marks would take roughly 15
  minutes; the household's client timed out after 60 seconds. Delivery now
  continues in the background. The result's new `markers` field (`none` |
  `queued` | `not-scheduled` | `unresolved`) says whether marks were scheduled, never
  that Discord accepted them. If the ledger write after the switch fails, the
  rollback that already applied is no longer reported as failed: the batch is
  retired (`not-scheduled`), or, if even that write fails, the result says
  the batch may still be delivered (`unresolved`). A suppression whose
  redactions all committed is no longer undone by that failure.
