- **Resident scripts parsing history `extract`:** without a `channelId`,
  `extract` no longer returns `matchedCount` (a time-only native query only
  ever reported the page size there, not a total). It returns `hasMore`
  instead; channel-scoped `extract` keeps its exact `matchedCount`.
