- Widen Safe B exhaustion recovery beyond the previously documented pre-stream
  path: registered provider streams now retain the failed compile's branch/body
  witness and report qualifying exhaustion after iterator completion, queued
  delivery and terminal teardown. Only qualifying failures can quarantine; live/unsettled
  work and stale terminal owners still decline. Ordinary non-recovery failures
  keep their existing reporting timing even when outgoing delivery is pending.
  Observed transcript-only calls no longer reserve the reader's native tool IDs. Reentrant recovery during
  removal notifications declines, and host `/unstick` rejects non-finite or
  nonnumeric budgets. Legacy removals reconcile other windows even if the
  remover changes branch after the write. Recovery logs distinguish waiting
  from repair and do not recommend uninspected `/undo`.
