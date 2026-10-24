- `maxSyncPerTick` and `maxSyncBeforeSearch` are now the most items one
  pass writes to the semantic index: what the service reports each upsert
  inserted or updated, with each queued edit counted as one. A pass stops
  where that runs out, inside a millisecond's summaries or a page of
  messages too, and the next pass goes on from there. Their documentation
  had called them the most items a pass would push, which no pass kept: the
  message walk checked once per page of 256, and messages the overlap behind
  the cursor found new went uncounted. A pass still re-sends items the
  service holds unchanged, such as that overlap's, and those cost nothing,
  so a backlog in the overlap can't use a pass up.
