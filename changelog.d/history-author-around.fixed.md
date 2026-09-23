- History `extract` without a channel no longer reports a `matchedCount` that
  was only the page size (a time-only native query returns a page-sized count,
  not a total). It now reports `hasMore`, and keeps the exact `matchedCount`
  only for channel-scoped queries.
